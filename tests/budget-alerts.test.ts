// @vitest-environment node
// Required: TanStack Start's import protection mocks server modules in jsdom (client) environment.

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db, schema } from "../src/db/index.ts";
import {
  checkBudgetAlerts,
  runBudgetAlertCheck,
} from "../src/server/budget-alerts.server.ts";
import { createBudget, deleteBudget } from "../src/server/budgets.server.ts";
import { env } from "../src/server/env.ts";

// The real sendEmail runs (TEST_MODE captures messages in memory) unless a
// test flips `failSend` to simulate a provider outage.
const emailControl = vi.hoisted(() => ({ failSend: false }));
vi.mock("../src/server/email.ts", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../src/server/email.ts")>();
  return {
    ...original,
    sendEmail: async (message: Parameters<typeof original.sendEmail>[0]) => {
      if (emailControl.failSend) throw new Error("simulated email outage");
      return original.sendEmail(message);
    },
  };
});

const { getCapturedEmails } = await import("../src/server/email.ts");

describe("over-budget email alerts", () => {
  const NOW = new Date("2026-07-15T12:00:00Z");
  const NEXT_MONTH = new Date("2026-08-15T12:00:00Z");

  // Unique per test: the in-memory email capture is never cleared, so every
  // test reads back only the messages sent to its own address.
  let userId: string;
  let email: string;
  let counter = 0;

  const alertRows = () =>
    db
      .select()
      .from(schema.budget_alerts)
      .where(eq(schema.budget_alerts.user_id, userId));

  const addCategory = async (name: string, parentId: string | null = null) => {
    const id = `${userId}-cat-${name}`;
    await db.insert(schema.categories).values({
      id,
      user_id: userId,
      name,
      parent_id: parentId,
    });
    return id;
  };

  const addBudget = async (categoryId: string, limitMinor: number) => {
    const result = await createBudget(userId, { categoryId, limitMinor }, db);
    if (!("success" in result)) throw new Error(result.error);
    return result.id;
  };

  const spend = (categoryId: string, amountMinor: number, date = "2026-07-10") =>
    db.insert(schema.transactions).values({
      id: crypto.randomUUID(),
      user_id: userId,
      account_id: `${userId}-acc`,
      date,
      amount_minor: amountMinor,
      category_id: categoryId,
    });

  beforeEach(async () => {
    emailControl.failSend = false;
    userId = `budget-alerts-user-${++counter}`;
    email = `${userId}@example.com`;
    await db.insert(schema.users).values({
      id: userId,
      username: userId,
      email,
      email_verified_at: new Date("2026-01-01T00:00:00Z"),
      password_hash: "x",
    });
    await db.insert(schema.accounts).values({
      id: `${userId}-acc`,
      user_id: userId,
      name: "Checking",
      currency: "PLN",
    });
  });

  afterEach(async () => {
    await db
      .delete(schema.budget_alerts)
      .where(eq(schema.budget_alerts.user_id, userId));
    await db.delete(schema.budgets).where(eq(schema.budgets.user_id, userId));
    await db
      .delete(schema.transactions)
      .where(eq(schema.transactions.user_id, userId));
    // Children first — parent_id references categories.
    const categories = await db
      .select({ id: schema.categories.id, parentId: schema.categories.parent_id })
      .from(schema.categories)
      .where(eq(schema.categories.user_id, userId));
    for (const c of categories.filter((c) => c.parentId)) {
      await db.delete(schema.categories).where(eq(schema.categories.id, c.id));
    }
    await db
      .delete(schema.categories)
      .where(eq(schema.categories.user_id, userId));
    await db.delete(schema.accounts).where(eq(schema.accounts.user_id, userId));
    await db.delete(schema.users).where(eq(schema.users.id, userId));
  });

  it("sends one email naming the category, limit and spent amount when over", async () => {
    const categoryId = await addCategory("Groceries");
    await addBudget(categoryId, 10_000);
    await spend(categoryId, -12_345);

    expect(await checkBudgetAlerts(userId, NOW, db)).toBe(1);

    const emails = getCapturedEmails(email);
    expect(emails).toHaveLength(1);
    expect(emails[0].subject).toContain("Groceries");
    expect(emails[0].text).toContain("Groceries");
    expect(emails[0].text).toContain("100.00");
    expect(emails[0].text).toContain("123.45");
    expect(emails[0].text).toContain(`${env.email.baseUrl}/budgets`);

    const rows = await alertRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      user_id: userId,
      category_id: categoryId,
      month: "2026-07",
    });
  });

  it("sends nothing when spending is under or exactly at the limit", async () => {
    const categoryId = await addCategory("Groceries");
    await addBudget(categoryId, 10_000);

    await spend(categoryId, -9_999);
    expect(await checkBudgetAlerts(userId, NOW, db)).toBe(0);

    // Exactly the limit is still within budget.
    await spend(categoryId, -1);
    expect(await checkBudgetAlerts(userId, NOW, db)).toBe(0);

    expect(getCapturedEmails(email)).toHaveLength(0);
    expect(await alertRows()).toHaveLength(0);

    // One more grosz tips it over.
    await spend(categoryId, -1);
    expect(await checkBudgetAlerts(userId, NOW, db)).toBe(1);
    expect(getCapturedEmails(email)).toHaveLength(1);
  });

  it("ignores income and spending dated in another month", async () => {
    const categoryId = await addCategory("Groceries");
    await addBudget(categoryId, 10_000);
    await spend(categoryId, 50_000); // refund / income
    await spend(categoryId, -50_000, "2026-06-30");

    expect(await checkBudgetAlerts(userId, NOW, db)).toBe(0);
    expect(getCapturedEmails(email)).toHaveLength(0);
  });

  it("counts subcategory spending towards a parent budget", async () => {
    const parentId = await addCategory("Food");
    const childId = await addCategory("Restaurants", parentId);
    await addBudget(parentId, 10_000);
    await spend(childId, -10_001);

    expect(await checkBudgetAlerts(userId, NOW, db)).toBe(1);
    const emails = getCapturedEmails(email);
    expect(emails).toHaveLength(1);
    expect(emails[0].subject).toContain("Food");
  });

  it("does not send a second email in the same month", async () => {
    const categoryId = await addCategory("Groceries");
    await addBudget(categoryId, 10_000);
    await spend(categoryId, -20_000);

    expect(await checkBudgetAlerts(userId, NOW, db)).toBe(1);
    await spend(categoryId, -5_000);
    expect(await checkBudgetAlerts(userId, NOW, db)).toBe(0);
    expect(
      await checkBudgetAlerts(userId, new Date("2026-07-31T23:59:59Z"), db),
    ).toBe(0);

    expect(getCapturedEmails(email)).toHaveLength(1);
    expect(await alertRows()).toHaveLength(1);
  });

  it("sends again when the budget is exceeded in a new month", async () => {
    const categoryId = await addCategory("Groceries");
    await addBudget(categoryId, 10_000);
    await spend(categoryId, -20_000);
    expect(await checkBudgetAlerts(userId, NOW, db)).toBe(1);

    // New month, nothing spent yet: budgets reset, no email.
    expect(await checkBudgetAlerts(userId, NEXT_MONTH, db)).toBe(0);

    await spend(categoryId, -20_000, "2026-08-02");
    expect(await checkBudgetAlerts(userId, NEXT_MONTH, db)).toBe(1);

    expect(getCapturedEmails(email)).toHaveLength(2);
    const months = (await alertRows()).map((r) => r.month).sort();
    expect(months).toEqual(["2026-07", "2026-08"]);
  });

  it("sends exactly one email when two checks run concurrently", async () => {
    const categoryId = await addCategory("Groceries");
    await addBudget(categoryId, 10_000);
    await spend(categoryId, -20_000);

    const results = await Promise.all([
      checkBudgetAlerts(userId, NOW, db),
      checkBudgetAlerts(userId, NOW, db),
      checkBudgetAlerts(userId, NOW, db),
    ]);

    expect(results.reduce((a, b) => a + b, 0)).toBe(1);
    expect(getCapturedEmails(email)).toHaveLength(1);
    expect(await alertRows()).toHaveLength(1);
  });

  it("sends nothing and writes no ledger row for an unverified email", async () => {
    await db
      .update(schema.users)
      .set({ email_verified_at: null })
      .where(eq(schema.users.id, userId));
    const categoryId = await addCategory("Groceries");
    await addBudget(categoryId, 10_000);
    await spend(categoryId, -20_000);

    expect(await checkBudgetAlerts(userId, NOW, db)).toBe(0);
    expect(getCapturedEmails(email)).toHaveLength(0);
    expect(await alertRows()).toHaveLength(0);

    // Once verified, the next write still triggers the alert.
    await db
      .update(schema.users)
      .set({ email_verified_at: new Date() })
      .where(eq(schema.users.id, userId));
    expect(await checkBudgetAlerts(userId, NOW, db)).toBe(1);
    expect(getCapturedEmails(email)).toHaveLength(1);
  });

  it("sends nothing and writes no ledger row when the user has no email", async () => {
    await db
      .update(schema.users)
      .set({ email: null })
      .where(eq(schema.users.id, userId));
    const categoryId = await addCategory("Groceries");
    await addBudget(categoryId, 10_000);
    await spend(categoryId, -20_000);

    const before = getCapturedEmails().length;
    expect(await checkBudgetAlerts(userId, NOW, db)).toBe(0);
    expect(getCapturedEmails().length).toBe(before);
    expect(await alertRows()).toHaveLength(0);
  });

  it("sends one email per budget when two budgets are over", async () => {
    const groceries = await addCategory("Groceries");
    const transport = await addCategory("Transport");
    const rent = await addCategory("Rent");
    await addBudget(groceries, 10_000);
    await addBudget(transport, 5_000);
    await addBudget(rent, 300_000);
    await spend(groceries, -10_001);
    await spend(transport, -7_500);
    await spend(rent, -250_000); // within budget

    expect(await checkBudgetAlerts(userId, NOW, db)).toBe(2);

    const subjects = getCapturedEmails(email).map((e) => e.subject);
    expect(subjects).toHaveLength(2);
    expect(subjects.some((s) => s.includes("Groceries"))).toBe(true);
    expect(subjects.some((s) => s.includes("Transport"))).toBe(true);
    expect(subjects.some((s) => s.includes("Rent"))).toBe(false);
    expect(await alertRows()).toHaveLength(2);
  });

  it("does not re-send when the budget is deleted and re-created in the same month", async () => {
    const categoryId = await addCategory("Groceries");
    const budgetId = await addBudget(categoryId, 10_000);
    await spend(categoryId, -20_000);
    expect(await checkBudgetAlerts(userId, NOW, db)).toBe(1);

    await deleteBudget(userId, budgetId, db);
    await addBudget(categoryId, 5_000);

    expect(await checkBudgetAlerts(userId, NOW, db)).toBe(0);
    expect(getCapturedEmails(email)).toHaveLength(1);
  });

  it("releases the claim when sending fails so a later check retries", async () => {
    const categoryId = await addCategory("Groceries");
    await addBudget(categoryId, 10_000);
    await spend(categoryId, -20_000);

    emailControl.failSend = true;
    expect(await checkBudgetAlerts(userId, NOW, db)).toBe(0);
    expect(getCapturedEmails(email)).toHaveLength(0);
    expect(await alertRows()).toHaveLength(0);

    emailControl.failSend = false;
    expect(await checkBudgetAlerts(userId, NOW, db)).toBe(1);
    expect(getCapturedEmails(email)).toHaveLength(1);
    expect(await alertRows()).toHaveLength(1);
  });

  it("never alerts another user's budgets", async () => {
    const categoryId = await addCategory("Groceries");
    await addBudget(categoryId, 10_000);
    await spend(categoryId, -20_000);

    const otherId = `${userId}-other`;
    await db.insert(schema.users).values({
      id: otherId,
      username: otherId,
      email: `${otherId}@example.com`,
      email_verified_at: new Date(),
      password_hash: "x",
    });
    try {
      expect(await checkBudgetAlerts(otherId, NOW, db)).toBe(0);
      expect(getCapturedEmails(`${otherId}@example.com`)).toHaveLength(0);
      expect(getCapturedEmails(email)).toHaveLength(0);
    } finally {
      await db.delete(schema.users).where(eq(schema.users.id, otherId));
    }
  });

  it("runBudgetAlertCheck never throws", async () => {
    await expect(runBudgetAlertCheck(userId)).resolves.toBeUndefined();
    await expect(
      runBudgetAlertCheck("budget-alerts-missing-user"),
    ).resolves.toBeUndefined();
  });
});
