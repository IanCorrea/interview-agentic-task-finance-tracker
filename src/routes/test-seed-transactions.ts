import { createFileRoute } from "@tanstack/react-router";
import { and, eq } from "drizzle-orm";
import { db, schema } from "#/db";
import { requireUserId } from "#/server/session";

// Test-only endpoint: inserts transactions for the signed-in user straight
// into the database so E2E tests can set up "spent this month" scenarios
// without driving the transaction form once per row.
//
// It deliberately does NOT run the over-budget alert check — tests that
// assert on the alert email must go through a real write path (the UI).
//
// Body (JSON): { transactions: [{ category, amountMinor, date }] }
//   category    — category name of the signed-in user (e.g. "Groceries")
//   amountMinor — signed integer minor units (negative = spending)
//   date        — YYYY-MM-DD
//
// Only enabled when TEST_MODE=1 (same gating as test-create-user).
export const Route = createFileRoute("/test-seed-transactions")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (process.env.TEST_MODE !== "1") {
          return new Response("Not available", { status: 404 });
        }

        const userId = await requireUserId();
        const body = (await request.json()) as {
          transactions?: {
            category: string;
            amountMinor: number;
            date: string;
          }[];
        };
        const rows = body.transactions ?? [];
        if (rows.length === 0) {
          return new Response("Bad request", { status: 400 });
        }

        const accounts = await db
          .select({ id: schema.accounts.id })
          .from(schema.accounts)
          .where(eq(schema.accounts.user_id, userId))
          .limit(1);
        const accountId = accounts[0]?.id;
        if (!accountId) {
          return new Response("No account", { status: 400 });
        }

        for (const row of rows) {
          const categories = await db
            .select({ id: schema.categories.id })
            .from(schema.categories)
            .where(
              and(
                eq(schema.categories.user_id, userId),
                eq(schema.categories.name, row.category),
              ),
            )
            .limit(1);
          const categoryId = categories[0]?.id;
          if (!categoryId || !Number.isInteger(row.amountMinor)) {
            return new Response(`Bad row: ${row.category}`, { status: 400 });
          }
          await db.insert(schema.transactions).values({
            id: crypto.randomUUID(),
            user_id: userId,
            account_id: accountId,
            date: row.date,
            amount_minor: row.amountMinor,
            description: "e2e seed",
            category_id: categoryId,
            source: "manual",
          });
        }

        return Response.json({ seeded: rows.length });
      },
    },
  },
});
