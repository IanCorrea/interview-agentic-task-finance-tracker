import { and, eq, gte, isNotNull, lt, sql } from "drizzle-orm";
import { db as defaultDb, schema } from "#/db";
import { checkBudgetLimit } from "#/server/billing.server";

//
// Monthly category budgets — domain logic. Server-only: imported by
// budgets.functions.ts handlers, the over-budget alert check and unit tests.
//
// Only the limit is stored. "Spent" is derived on every read from the
// transactions dated in the current calendar month, so budgets reset by
// themselves when the month rolls over — there is no reset job to forget.
//
// Rules (see docs/KICKOFF.md):
//   - only spending counts: negative amounts, summed as absolute values;
//     income and refunds (positive amounts) never reduce the spent amount;
//   - a budget covers its category AND every descendant category;
//   - the month is the UTC calendar month, the same convention the monthly
//     AI scan quota uses (ai-usage.server.ts);
//   - amounts are summed across accounts without currency conversion, the
//     same behaviour as the dashboard totals.

type Db = typeof defaultDb;

/** Largest limit accepted: keeps `limit_minor` inside a Postgres integer. */
export const MAX_BUDGET_LIMIT_MINOR = 2_000_000_000;

export interface BudgetMonth {
  /** "YYYY-MM" */
  month: string;
  /** First day of the month, "YYYY-MM-DD" (inclusive). */
  from: string;
  /** First day of the next month, "YYYY-MM-DD" (exclusive). */
  to: string;
}

/** The UTC calendar month containing `now`, as date-string bounds that can be
 * compared directly with the `transactions.date` column. */
export function budgetMonth(now: Date = new Date()): BudgetMonth {
  const year = now.getUTCFullYear();
  const monthIndex = now.getUTCMonth();
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const from = iso(new Date(Date.UTC(year, monthIndex, 1)));
  const to = iso(new Date(Date.UTC(year, monthIndex + 1, 1)));
  return { month: from.slice(0, 7), from, to };
}

export interface BudgetStatus {
  id: string;
  categoryId: string;
  categoryName: string;
  categoryColor: string | null;
  /** Name of the parent category, when the budget is on a subcategory. */
  parentCategoryName: string | null;
  /** All amounts are integer minor units (grosze/cents). */
  limitMinor: number;
  spentMinor: number;
  /** limit − spent; negative when over budget. */
  remainingMinor: number;
  /** True only when spent is strictly greater than the limit. */
  isOver: boolean;
}

/**
 * Every budget of the user with its spending for the month containing `now`.
 * Three queries regardless of the number of budgets: budgets, the category
 * tree, and one grouped expense sum per category for the month.
 */
export async function getBudgetStatuses(
  userId: string,
  now: Date = new Date(),
  db: Db = defaultDb,
): Promise<BudgetStatus[]> {
  const budgets = await db
    .select({
      id: schema.budgets.id,
      categoryId: schema.budgets.category_id,
      limitMinor: schema.budgets.limit_minor,
    })
    .from(schema.budgets)
    .where(eq(schema.budgets.user_id, userId));
  if (budgets.length === 0) return [];

  const categories = await db
    .select({
      id: schema.categories.id,
      name: schema.categories.name,
      color: schema.categories.color,
      parentId: schema.categories.parent_id,
    })
    .from(schema.categories)
    .where(eq(schema.categories.user_id, userId));
  const categoryById = new Map(categories.map((c) => [c.id, c]));
  const childrenByParent = new Map<string, string[]>();
  for (const category of categories) {
    if (!category.parentId) continue;
    const siblings = childrenByParent.get(category.parentId) ?? [];
    siblings.push(category.id);
    childrenByParent.set(category.parentId, siblings);
  }

  const { from, to } = budgetMonth(now);
  const spentRows = await db
    .select({
      categoryId: schema.transactions.category_id,
      // SUM over integers is bigint in Postgres (returned as a string) — map back to number.
      spent: sql<number>`COALESCE(SUM(ABS(${schema.transactions.amount_minor})), 0)`.mapWith(Number),
    })
    .from(schema.transactions)
    .where(
      and(
        eq(schema.transactions.user_id, userId),
        gte(schema.transactions.date, from),
        lt(schema.transactions.date, to),
        // Only spending counts — income/refunds are positive and excluded.
        lt(schema.transactions.amount_minor, 0),
        isNotNull(schema.transactions.category_id),
      ),
    )
    .groupBy(schema.transactions.category_id);
  const spentByCategory = new Map<string, number>();
  for (const row of spentRows) {
    if (row.categoryId) spentByCategory.set(row.categoryId, row.spent);
  }

  /** Spending of a category plus all of its descendants. */
  const spentInSubtree = (rootId: string): number => {
    let total = 0;
    const visited = new Set<string>();
    const stack = [rootId];
    while (stack.length > 0) {
      const id = stack.pop()!;
      // Guard against a (theoretically impossible) parent cycle.
      if (visited.has(id)) continue;
      visited.add(id);
      total += spentByCategory.get(id) ?? 0;
      stack.push(...(childrenByParent.get(id) ?? []));
    }
    return total;
  };

  return budgets
    .map((budget) => {
      const category = categoryById.get(budget.categoryId);
      const parent = category?.parentId
        ? categoryById.get(category.parentId)
        : undefined;
      const spentMinor = spentInSubtree(budget.categoryId);
      return {
        id: budget.id,
        categoryId: budget.categoryId,
        categoryName: category?.name ?? "",
        categoryColor: category?.color ?? null,
        parentCategoryName: parent?.name ?? null,
        limitMinor: budget.limitMinor,
        spentMinor,
        remainingMinor: budget.limitMinor - spentMinor,
        isOver: spentMinor > budget.limitMinor,
      };
    })
    .sort((a, b) => a.categoryName.localeCompare(b.categoryName));
}

export type BudgetMutationResult =
  | { success: true; id: string }
  | {
      error: string;
      code:
        | "category_not_found"
        | "budget_exists"
        | "budget_limit_reached"
        | "budget_not_found"
        | "invalid_limit";
      /** Set for budget_limit_reached so the UI can localize the message. */
      limit?: number;
    };

function isValidLimit(limitMinor: number): boolean {
  return (
    Number.isSafeInteger(limitMinor) &&
    limitMinor > 0 &&
    limitMinor <= MAX_BUDGET_LIMIT_MINOR
  );
}

/**
 * Create a budget for one of the user's categories. Checks, in order:
 * the category belongs to the user, no budget exists for it yet, and the
 * plan's budget allowance is not exhausted.
 */
export async function createBudget(
  userId: string,
  input: { categoryId: string; limitMinor: number },
  db: Db = defaultDb,
): Promise<BudgetMutationResult> {
  if (!isValidLimit(input.limitMinor)) {
    return { error: "Invalid budget limit", code: "invalid_limit" };
  }

  // Ownership in the same query — a foreign category is indistinguishable
  // from a missing one.
  const category = await db
    .select({ id: schema.categories.id })
    .from(schema.categories)
    .where(
      and(
        eq(schema.categories.id, input.categoryId),
        eq(schema.categories.user_id, userId),
      ),
    )
    .limit(1);
  if (category.length === 0) {
    return { error: "Category does not exist", code: "category_not_found" };
  }

  const existing = await db
    .select({ id: schema.budgets.id })
    .from(schema.budgets)
    .where(
      and(
        eq(schema.budgets.user_id, userId),
        eq(schema.budgets.category_id, input.categoryId),
      ),
    )
    .limit(1);
  if (existing.length > 0) {
    return {
      error: "This category already has a budget",
      code: "budget_exists",
    };
  }

  const id = crypto.randomUUID();
  // Count-then-insert must be atomic per user, otherwise parallel creates for
  // different categories all see the same count and slip past the plan limit.
  // The user's row is the lock: NO KEY UPDATE serializes budget creation for
  // this user without blocking writes that merely reference the user (those
  // take FOR KEY SHARE).
  return db.transaction(async (tx): Promise<BudgetMutationResult> => {
    await tx
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .for("no key update");

    const limit = await checkBudgetLimit(userId, tx as unknown as Db);
    if (!limit.allowed) {
      return { error: limit.error, code: limit.code, limit: limit.limit };
    }

    // The unique (user, category) index is the real guard against two
    // concurrent creates for the same category.
    const inserted = await tx
      .insert(schema.budgets)
      .values({
        id,
        user_id: userId,
        category_id: input.categoryId,
        limit_minor: input.limitMinor,
      })
      .onConflictDoNothing()
      .returning({ id: schema.budgets.id });
    if (inserted.length === 0) {
      return {
        error: "This category already has a budget",
        code: "budget_exists",
      };
    }
    return { success: true, id };
  });
}

/** Change the monthly limit of one of the user's budgets. */
export async function updateBudgetLimit(
  userId: string,
  input: { id: string; limitMinor: number },
  db: Db = defaultDb,
): Promise<BudgetMutationResult> {
  if (!isValidLimit(input.limitMinor)) {
    return { error: "Invalid budget limit", code: "invalid_limit" };
  }
  const updated = await db
    .update(schema.budgets)
    .set({ limit_minor: input.limitMinor, updated_at: new Date() })
    .where(
      and(eq(schema.budgets.id, input.id), eq(schema.budgets.user_id, userId)),
    )
    .returning({ id: schema.budgets.id });
  if (updated.length === 0) {
    return { error: "Budget not found", code: "budget_not_found" };
  }
  return { success: true, id: input.id };
}

/** Remove one of the user's budgets. The alert ledger is kept on purpose:
 * re-creating the budget in the same month must not send a second email. */
export async function deleteBudget(
  userId: string,
  id: string,
  db: Db = defaultDb,
): Promise<BudgetMutationResult> {
  const deleted = await db
    .delete(schema.budgets)
    .where(and(eq(schema.budgets.id, id), eq(schema.budgets.user_id, userId)))
    .returning({ id: schema.budgets.id });
  if (deleted.length === 0) {
    return { error: "Budget not found", code: "budget_not_found" };
  }
  return { success: true, id };
}
