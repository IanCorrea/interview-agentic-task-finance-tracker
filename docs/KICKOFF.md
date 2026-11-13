# Monthly category budgets — kickoff

Source of truth for the agent team working on [TASK.md](../TASK.md).
Project conventions live in [CLAUDE.md](../CLAUDE.md) and are binding.

## Design (approved by the human lead)

| Topic | Decision | Why |
|---|---|---|
| Spent | Derived on read: sum of `ABS(amount_minor)` of **negative** transactions dated in the current month, for the budget's category **and all descendants**. | "Only spending counts", "parent includes subcategories". Nothing stored → "budgets reset every month" needs no job. |
| Month | UTC calendar month (`budgetMonth()` in `budgets.server.ts`). | Same convention as the monthly AI scan quota (`ai-usage.server.ts`). |
| Budget | One per category (unique `user_id, category_id`), `limit_minor` integer minor units. | Money convention in `src/lib/money.ts`. |
| Over budget | `spent > limit` (strictly). | Spending exactly the limit is still within budget. |
| Email | Ledger table `budget_alerts`, unique `(user_id, category_id, month)`. Insert with `ON CONFLICT DO NOTHING`; send only if the insert won. | "Max one email per budget per month", safe under concurrent writes. Same idempotency pattern as `stripe_events`. Keyed by category so delete + re-create does not re-send. |
| Email triggers | After every write that can change spent vs. limit: manual transaction create/update/delete, CSV import (+ undo), receipt scan, recategorization/rules, category delete with reassignment, budget create / limit change. | No write path may be forgotten. |
| Email recipient | Only users with a **verified** email. No ledger row is written when there is nobody to email. | Never send financial information to an unverified address. |
| Free plan | 3 budgets (`BILLING_FREE_MAX_BUDGETS`, default 3), enforced server-side in `checkBudgetLimit` via `getEntitlements`. Existing budgets above the limit after a downgrade are kept. | Mirrors `checkAccountLimit`; entitlements stay the single source of truth. |
| Compliance | Budgets + alert ledger are in the GDPR export (JSON + CSV), deleted in `hardDeleteUser`, and deleted together with their category. All queries scoped by `user_id`. Logs carry ids/counts only. | "Budgets are user data". The new FKs would otherwise break account and category deletion. |
| Currency | Summed across accounts without conversion. | Existing dashboard behaviour; out of scope to change. |

Non-goals: budget history per month, rollover of unused amounts, multi-currency
conversion, alerts by channels other than email.

## Known limitations (found in review, accepted for this iteration)

- **Receipt-scan transactions do not count as spending.** They are stored with
  a positive `amount_minor` (`receipts.functions.ts`), which predates this
  feature — the dashboard also treats them as income. Budgets sum only
  negative amounts, so a scanned receipt neither increases "spent" nor
  triggers the email. Fixing the sign changes existing behaviour (receipt
  dedup `source_ref`, receipts E2E) and was left out of scope on purpose.
- **Only the current UTC month is evaluated.** A back-dated transaction that
  pushes a past month over its limit sends no email, and users far from UTC
  see the month switch a few hours early or late.
- **Email delivery is at-most-once.** A provider timeout keeps the ledger
  claim (the message may have been accepted), so that month's alert is not
  retried; a definite failure releases the claim and the next write retries.
- **One display currency.** Amounts are shown with the dashboard's currency
  label and summed across accounts without conversion.
- **Export.** Budgets are in `export.json` and `budgets.csv`; the alert ledger
  is in `export.json` only.
- The free-plan limit race is closed with a row lock on the user
  (`createBudget`); the same check-then-insert race still exists for accounts
  (`checkAccountLimit`), which is pre-existing code.

## Foundation (done by the lead before fan-out)

- `src/db/schema.ts` — `budgets`, `budget_alerts`; migration `drizzle/0004_*.sql`.
- `src/server/env.ts`, `billing.server.ts` — `freeMaxBudgets`, `Entitlements.maxBudgets`, `checkBudgetLimit`.
- `src/server/budgets.server.ts` — domain logic (statuses, create, update, delete).
- `src/server/budgets.functions.ts` — server functions `getBudgets`, `createBudget`, `updateBudget`, `deleteBudget`.
- `src/server/budget-alerts.server.ts` — contract stub (`checkBudgetAlerts`, `runBudgetAlertCheck`).
- `src/server/ownership.server.ts` — `budget` registered as an owned entity.

## Team and file ownership

Agents work in the same working tree at the same time. **Edit only the files
you own.** If you need a change in someone else's file, report it to the lead
instead of editing.

| Agent | Owns |
|---|---|
| `budgets-domain` | `tests/budgets.test.ts`, `tests/authorization.test.ts`, `tests/billing.test.ts`, `tests/env.test.ts`, `.env.example`; bug fixes in `src/server/budgets.server.ts` |
| `budgets-alerts` | `src/server/budget-alerts.server.ts`, `tests/budget-alerts.test.ts`, the alert hooks in `transactions/imports/receipts/categorization.functions.ts`, `email_budget_*` keys in `messages/en.json` |
| `budgets-compliance` | `src/server/compliance.server.ts`, `src/server/categories.functions.ts`, `tests/compliance.test.ts`, legal/privacy copy if it enumerates stored data |
| `budgets-frontend` | `src/routes/_authed/budgets.tsx`, `src/components/sidebar.tsx`, `budgets_*` / `nav_budgets` keys in `messages/en.json` |
| `budgets-qa` (phase 3) | `tests/e2e/budgets.spec.ts`, `tests/e2e/sidebar.spec.ts`, test-only routes if needed |
| `budgets-techlead` (phase 3) | read-only review against TASK.md, this document and CLAUDE.md |

## Phases and gates

1. **Foundation** — lead. Gate: typecheck + lint clean for the new modules.
2. **Build** — domain, alerts, compliance, frontend in parallel.
   Gate A: `pnpm run typecheck`, `pnpm run lint`, new unit tests green.
3. **Verify** — QA writes and runs the budgets E2E; tech lead reviews.
   Gate B: budgets + sidebar E2E green, no open blocker from the review.
4. **Ship** — lead fixes findings, runs the regression specs, commits, pushes.

## Test strategy (time-boxed to ~2 hours in total)

The full `pnpm run check` takes ~10 minutes on this machine and its E2E part
times out under the default worker count (baseline before any change: 114
passed, 36 failed by 30s timeouts; the same specs pass with `--workers=2`).

- While building: `pnpm run typecheck`, `pnpm run lint`, and only your own
  unit test file: `pnpm exec vitest run tests/<file>.test.ts`.
- **Do not run Playwright** unless you are `budgets-qa` — there is one port
  3000 and one server.
- QA: `pnpm exec playwright test budgets.spec.ts sidebar.spec.ts --workers=2 --reporter=line`.
- Final regression by the lead: the E2E specs of the areas the feature touches,
  with `--workers=2`.

Other agents are editing at the same time, so typecheck may show errors in
files you do not own. Fix only your own; mention the others in your report.

## Definition of done (every agent)

- Follows CLAUDE.md: pnpm only, `*.functions.ts` / `*.server.ts` split, routes
  import only server functions, TanStack Query, all UI text via Paraglide.
- Every query scoped by `user_id`; no financial content in logs.
- Report back: what changed (files), what was verified (commands + result),
  what is not done or uncertain.
