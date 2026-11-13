import { and, eq, inArray } from "drizzle-orm";
import { db, schema } from "#/db";
import { ownedEntityExists } from "#/server/ownership.server";

//
// Server-only category logic. Imported by categories.functions.ts handlers
// and by unit tests — never from route components.

export type DeleteCategoryResult = { success: true } | { error: string };

/**
 * Delete a category and all of its descendants for `userId`.
 *
 * There are no cascade clauses, so every row referencing the deleted
 * categories is handled here first: transactions are reassigned (or
 * uncategorized), receipt items are uncategorized, and categorization rules,
 * budgets and the budget alert ledger are deleted. Everything is scoped by
 * `user_id` and runs in one transaction.
 */
export async function deleteCategoryForUser(
  userId: string,
  data: { id: string; reassignToCategoryId?: string | null },
): Promise<DeleteCategoryResult> {
  // A foreign category is indistinguishable from a missing one.
  if (!(await ownedEntityExists("category", userId, data.id))) {
    return { error: "Category not found" };
  }

  // Walk the user's category tree in memory to collect all descendants.
  const userCategories = await db
    .select({
      id: schema.categories.id,
      parent_id: schema.categories.parent_id,
    })
    .from(schema.categories)
    .where(eq(schema.categories.user_id, userId));

  const allIdsToDelete: string[] = [data.id];
  const seen = new Set<string>(allIdsToDelete);
  for (let i = 0; i < allIdsToDelete.length; i++) {
    for (const category of userCategories) {
      if (category.parent_id === allIdsToDelete[i] && !seen.has(category.id)) {
        seen.add(category.id);
        allIdsToDelete.push(category.id);
      }
    }
  }

  const reassignTo = data.reassignToCategoryId || null;
  if (reassignTo) {
    // The target must survive the delete: neither the category itself nor
    // one of its descendants.
    if (seen.has(reassignTo)) {
      return {
        error: "Cannot reassign transactions to the category being deleted",
      };
    }
    if (!(await ownedEntityExists("category", userId, reassignTo))) {
      return { error: "Reassignment target category does not exist" };
    }
  }

  const userReceiptIds = db
    .select({ id: schema.receipts.id })
    .from(schema.receipts)
    .where(eq(schema.receipts.user_id, userId));

  await db.transaction(async (tx) => {
    // Reassign transactions to the target, or reset them to uncategorized.
    await tx
      .update(schema.transactions)
      .set({ category_id: reassignTo })
      .where(
        and(
          inArray(schema.transactions.category_id, allIdsToDelete),
          eq(schema.transactions.user_id, userId),
        ),
      );

    await tx
      .update(schema.receipt_items)
      .set({ category_id: null })
      .where(
        and(
          inArray(schema.receipt_items.category_id, allIdsToDelete),
          inArray(schema.receipt_items.receipt_id, userReceiptIds),
        ),
      );

    await tx
      .delete(schema.categorization_rules)
      .where(
        and(
          inArray(schema.categorization_rules.category_id, allIdsToDelete),
          eq(schema.categorization_rules.user_id, userId),
        ),
      );

    // Budgets and their alert ledger go with the category.
    await tx
      .delete(schema.budget_alerts)
      .where(
        and(
          inArray(schema.budget_alerts.category_id, allIdsToDelete),
          eq(schema.budget_alerts.user_id, userId),
        ),
      );
    await tx
      .delete(schema.budgets)
      .where(
        and(
          inArray(schema.budgets.category_id, allIdsToDelete),
          eq(schema.budgets.user_id, userId),
        ),
      );

    // Children before parents: the list is in breadth-first order from the
    // target, so delete it in reverse.
    for (const id of [...allIdsToDelete].reverse()) {
      await tx
        .delete(schema.categories)
        .where(
          and(
            eq(schema.categories.id, id),
            eq(schema.categories.user_id, userId),
          ),
        );
    }
  });

  return { success: true };
}
