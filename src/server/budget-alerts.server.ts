import { and, eq } from "drizzle-orm";
import { db as defaultDb, schema } from "#/db";
import { formatMinor } from "#/lib/money";
import { m } from "#/paraglide/messages";
import { budgetMonth, getBudgetStatuses } from "#/server/budgets.server";
import { sendEmail } from "#/server/email";
import { env } from "#/server/env";
import { getLogger } from "#/server/logger";

//
// Over-budget email alerts. Server-only.
//
// CONTRACT (owned by the `alerts` agent — see .claude/agents/budgets-alerts.md):
//   - checkBudgetAlerts: for every budget of the user that is over its limit
//     in the month containing `now`, claim the (user, category, month) row in
//     budget_alerts with INSERT ... ON CONFLICT DO NOTHING and send one email
//     only when the claim won. Returns the number of emails sent.
//   - runBudgetAlertCheck: the wrapper every write path calls. It must never
//     throw — a failing alert must not fail the user's mutation.
//
// "Max one email per budget per month" is enforced by the unique
// (user_id, category_id, month) index, not by application logic: two
// concurrent writes both see the budget as over, but only one INSERT returns
// a row. Same idempotency pattern as processStripeEvent (billing.server.ts).
// The ledger is keyed by category, so deleting and re-creating a budget in the
// same month does not send a second email.

type Db = typeof defaultDb;

export async function checkBudgetAlerts(
  userId: string,
  now: Date = new Date(),
  db: Db = defaultDb,
): Promise<number> {
  const statuses = await getBudgetStatuses(userId, now, db);
  const over = statuses.filter((status) => status.isOver);
  if (over.length === 0) return 0;

  // Financial information only ever goes to a verified address. Nothing is
  // claimed when there is nobody to email, so the alert can still go out on a
  // later write once the user verifies.
  const users = await db
    .select({
      email: schema.users.email,
      emailVerifiedAt: schema.users.email_verified_at,
    })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);
  const user = users[0];
  if (!user?.email || !user.emailVerifiedAt) return 0;

  const { month } = budgetMonth(now);
  let sent = 0;

  for (const status of over) {
    const claimed = await db
      .insert(schema.budget_alerts)
      .values({
        id: crypto.randomUUID(),
        user_id: userId,
        category_id: status.categoryId,
        month,
      })
      .onConflictDoNothing()
      .returning({ id: schema.budget_alerts.id });
    // Already alerted for this budget this month (or a concurrent check won).
    if (claimed.length === 0) continue;

    try {
      await sendEmail({
        to: user.email,
        subject: m.email_budget_exceeded_subject({
          category: status.categoryName,
        }),
        text: m.email_budget_exceeded_body({
          category: status.categoryName,
          limit: formatMinor(status.limitMinor),
          spent: formatMinor(status.spentMinor),
          link: `${env.email.baseUrl}/budgets`,
        }),
      });
      sent++;
    } catch (error) {
      // A timeout is ambiguous: the provider may have accepted the message.
      // "Max one email per budget per month" wins over retrying, so the claim
      // is kept. Any other failure means nothing was sent — release the claim
      // so a later write can retry the email.
      const ambiguous =
        error instanceof Error &&
        (error.name === "TimeoutError" || error.name === "AbortError");
      if (!ambiguous) {
        await db
          .delete(schema.budget_alerts)
          .where(
            and(
              eq(schema.budget_alerts.id, claimed[0].id),
              eq(schema.budget_alerts.user_id, userId),
            ),
          );
      }
      // Ids only — never amounts or category names in logs.
      getLogger().error(
        { err: error, userId, categoryId: status.categoryId, month },
        "budget alert email failed",
      );
    }
  }

  return sent;
}

export async function runBudgetAlertCheck(userId: string): Promise<void> {
  try {
    await checkBudgetAlerts(userId);
  } catch (error) {
    // Ids only — never financial content in logs.
    getLogger().error({ err: error, userId }, "budget alert check failed");
  }
}
