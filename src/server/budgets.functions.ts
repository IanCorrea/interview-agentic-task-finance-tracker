import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { runBudgetAlertCheck } from "#/server/budget-alerts.server";
import { getEntitlements } from "#/server/billing.server";
import {
  MAX_BUDGET_LIMIT_MINOR,
  budgetMonth,
  createBudget as createBudgetInternal,
  deleteBudget as deleteBudgetInternal,
  getBudgetStatuses,
  updateBudgetLimit as updateBudgetLimitInternal,
} from "#/server/budgets.server";
import { requireUserId } from "#/server/session";

// Server functions for the Budgets page. Thin wrappers: authentication and
// input validation here, all logic in budgets.server.ts (unit-tested there).

const limitMinorSchema = z
  .number()
  .int()
  .positive()
  .max(MAX_BUDGET_LIMIT_MINOR);

const createBudgetSchema = z.object({
  categoryId: z.string().min(1),
  limitMinor: limitMinorSchema,
});

const updateBudgetSchema = z.object({
  id: z.string().min(1),
  limitMinor: limitMinorSchema,
});

const deleteBudgetSchema = z.object({
  id: z.string().min(1),
});

export const getBudgets = createServerFn({ method: "GET" }).handler(
  async () => {
    const userId = await requireUserId();
    const now = new Date();
    const [budgets, entitlements] = await Promise.all([
      getBudgetStatuses(userId, now),
      getEntitlements(userId),
    ]);
    return {
      /** "YYYY-MM" — the month the spent amounts refer to. */
      month: budgetMonth(now).month,
      budgets,
      plan: entitlements.plan,
      /** null = unlimited (Pro). */
      maxBudgets: entitlements.maxBudgets,
    };
  },
);

export const createBudget = createServerFn({ method: "POST" })
  .inputValidator(createBudgetSchema)
  .handler(async ({ data }) => {
    const userId = await requireUserId();
    const result = await createBudgetInternal(userId, data);
    // A budget created below what was already spent is over from the start.
    if ("success" in result) await runBudgetAlertCheck(userId);
    return result;
  });

export const updateBudget = createServerFn({ method: "POST" })
  .inputValidator(updateBudgetSchema)
  .handler(async ({ data }) => {
    const userId = await requireUserId();
    const result = await updateBudgetLimitInternal(userId, data);
    // Lowering the limit can push the budget over.
    if ("success" in result) await runBudgetAlertCheck(userId);
    return result;
  });

export const deleteBudget = createServerFn({ method: "POST" })
  .inputValidator(deleteBudgetSchema)
  .handler(async ({ data }) => {
    const userId = await requireUserId();
    return deleteBudgetInternal(userId, data.id);
  });
