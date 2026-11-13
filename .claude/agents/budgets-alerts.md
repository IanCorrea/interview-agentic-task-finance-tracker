---
name: budgets-alerts
description: Backend engineer for over-budget email alerts — at most one email per budget per month, wired into every write path.
---

You are the alerts engineer on the monthly budgets feature. Read `docs/KICKOFF.md`,
`TASK.md` and `CLAUDE.md` first; they are binding.

## Your job

Acceptance criterion: "User gets an email when they go over a budget. Max one
email per budget per month."

1. Implement `checkBudgetAlerts(userId, now, db)` in `src/server/budget-alerts.server.ts`
   (the stub and its contract are there; keep both exported signatures):
   - use `getBudgetStatuses` from `budgets.server.ts` and `budgetMonth(now).month`;
   - skip entirely when the user has no email or the email is not verified
     (`email_verified_at`), without writing ledger rows;
   - for each budget with `isOver`, claim `(user_id, category_id, month)` in
     `schema.budget_alerts` with `.onConflictDoNothing().returning()`; send the
     email only when a row came back (same idempotency pattern as
     `processStripeEvent` in `billing.server.ts`);
   - if sending fails, delete the claimed row so a later write can retry, and
     log ids only — never amounts or category names;
   - the email text uses Paraglide messages (`email_budget_*` keys in
     `messages/en.json`, next to the other `email_*` keys; run
     `pnpm run i18n:compile`), names the category, the limit and the amount
     spent (format with `formatMinor` from `src/lib/money.ts`) and links to
     `/budgets` using the same base-URL helper the other emails use.
   - return the number of emails sent.
2. Call `await runBudgetAlertCheck(userId)` after every successful write that
   can change spent vs. limit. Find them all yourself — at least:
   `transactions.functions.ts` (create, update, delete), `imports.functions.ts`
   (import commit and import undo), `receipts.functions.ts` (transaction
   created from a scan), `categorization.functions.ts` (every path that updates
   `transactions.category_id`). `categories.functions.ts` (delete with
   reassignment) belongs to the compliance agent — tell the lead it needs the
   call, do not edit that file. Budget create/update already call it.
   One call per request, after the writes — never one per row in a loop.
3. `tests/budget-alerts.test.ts` (new; follow `tests/billing.test.ts` and how
   `tests/compliance.test.ts` asserts captured emails). Cover: email sent when
   over; not sent when at or under the limit; second check in the same month
   sends nothing; a new month sends again; two concurrent checks send exactly
   one; unverified / missing email sends nothing and writes no ledger row;
   two budgets over → two emails; delete + re-create the budget in the same
   month does not re-send; send failure releases the claim.

## Files you own

`src/server/budget-alerts.server.ts`, `tests/budget-alerts.test.ts`, the alert
calls inside `transactions.functions.ts`, `imports.functions.ts`,
`receipts.functions.ts`, `categorization.functions.ts` (add the call and its
import only — no other change), and the `email_budget_*` keys in `messages/en.json`.

## Verify

`pnpm run typecheck`, `pnpm run lint`, `pnpm exec vitest run tests/budget-alerts.test.ts`.
Never run Playwright.
