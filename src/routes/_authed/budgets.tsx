import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, useEffect } from "react";
import { m } from "#/paraglide/messages";
import { getLocale } from "#/paraglide/runtime";
import { formatMinor, parseAmountToMinor } from "#/lib/money";
import { EditButton, DeleteButton } from "#/components/ui/action-buttons";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { Select, SelectItem } from "#/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "#/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "#/components/ui/alert-dialog";
import {
  getBudgets,
  createBudget,
  updateBudget,
  deleteBudget,
} from "#/server/budgets.functions";
import { getCategories } from "#/server/categories.functions";

const BUDGETS_QUERY_KEY = ["budgets"] as const;
const CATEGORIES_QUERY_KEY = ["categories"] as const;

/** Mirrors the server-side cap (MAX_BUDGET_LIMIT_MINOR); the server enforces it. */
const MAX_LIMIT_MINOR = 2_000_000_000;

/** Plain positive decimal with up to two fraction digits ("500", "49,99"). */
const LIMIT_PATTERN = /^\d+(?:[.,]\d{1,2})?$/;

type BudgetsData = Awaited<ReturnType<typeof getBudgets>>;
type BudgetRow = BudgetsData["budgets"][number];
type MutationResult = Awaited<ReturnType<typeof createBudget>>;

interface CategoryOption {
  id: string;
  label: string;
}

export const Route = createFileRoute("/_authed/budgets")({
  component: BudgetsPage,
});

// --- Helpers ---

function money(minor: number): string {
  return `${formatMinor(minor)} ${m.analytics_currency()}`;
}

function categoryLabel(name: string, parentName: string | null): string {
  return parentName
    ? m.budgets_category_path({ parent: parentName, child: name })
    : name;
}

/** "2026-11" → "November 2026". The budget month is a UTC calendar month. */
function formatMonthLabel(month: string): string {
  const [year, monthNumber] = month.split("-").map(Number);
  if (!year || !monthNumber) return month;
  return new Intl.DateTimeFormat(getLocale(), {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, monthNumber - 1, 1)));
}

type LimitParse =
  | { ok: true; minor: number }
  | { ok: false; message: string };

/** Validate the limit field and convert it to minor units without float math. */
function parseLimit(raw: string): LimitParse {
  const value = raw.replace(/\s/g, "");
  const minor = LIMIT_PATTERN.test(value) ? parseAmountToMinor(value) : null;
  if (minor === null || minor <= 0) {
    return { ok: false, message: m.budgets_limit_invalid() };
  }
  if (minor > MAX_LIMIT_MINOR) {
    return {
      ok: false,
      message: m.budgets_limit_too_large({ max: money(MAX_LIMIT_MINOR) }),
    };
  }
  return { ok: true, minor };
}

/** Whole percent of the limit already spent; never rounds across the limit. */
function percentUsed(budget: BudgetRow): number {
  if (budget.limitMinor <= 0) return 0;
  const ratio = (budget.spentMinor * 100) / budget.limitMinor;
  return budget.isOver ? Math.ceil(ratio) : Math.floor(ratio);
}

function mutationErrorMessage(
  result: Extract<MutationResult, { error: string }>,
): string {
  switch (result.code) {
    case "budget_limit_reached":
      return result.limit === undefined
        ? result.error
        : m.budgets_limit_reached({ limit: result.limit });
    case "budget_exists":
      return m.budgets_error_exists();
    case "category_not_found":
      return m.budgets_error_category_not_found();
    case "budget_not_found":
      return m.budgets_error_not_found();
    case "invalid_limit":
      return m.budgets_limit_invalid();
    default:
      return m.budgets_error_generic();
  }
}

// --- Budget Row ---

function BudgetItem({
  budget,
  onEdit,
  onDelete,
}: {
  budget: BudgetRow;
  onEdit: (budget: BudgetRow) => void;
  onDelete: (budget: BudgetRow) => void;
}) {
  const label = categoryLabel(budget.categoryName, budget.parentCategoryName);
  const percent = percentUsed(budget);
  const color = budget.categoryColor ?? "#6b7280";

  return (
    <li
      aria-label={label}
      className="px-4 py-3.5 hover:bg-accent/50 transition-colors"
      data-testid="budget-row"
      data-over={budget.isOver ? "true" : "false"}
    >
      <div className="flex items-center gap-3">
        <span
          className="size-4 shrink-0 rounded-full border border-border/50 shadow-sm"
          style={{ backgroundColor: color }}
          aria-hidden="true"
        />
        <span className="flex-1 min-w-0 text-sm font-medium truncate">
          {categoryLabel(budget.categoryName, budget.parentCategoryName)}
        </span>
        {budget.isOver && (
          <Badge variant="destructive" data-testid="budget-over-badge">
            {m.budgets_over_badge()}
          </Badge>
        )}
        <span className="flex items-center gap-1 shrink-0">
          <EditButton onClick={() => onEdit(budget)} data-testid="edit-budget" />
          <DeleteButton
            onClick={() => onDelete(budget)}
            data-testid="delete-budget"
          />
        </span>
      </div>

      <div className="mt-3 flex items-center gap-3">
        <div
          role="progressbar"
          aria-label={m.budgets_progress_label({ category: label })}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.min(percent, 100)}
          aria-valuetext={m.budgets_progress_text({
            spent: money(budget.spentMinor),
            limit: money(budget.limitMinor),
          })}
          className="h-2 flex-1 rounded-full bg-muted overflow-hidden"
        >
          <div
            className={`h-full rounded-full ${
              budget.isOver ? "bg-destructive" : "bg-primary"
            }`}
            style={{ width: `${Math.min(percent, 100)}%` }}
          />
        </div>
        <span
          className="w-20 text-right text-xs text-muted-foreground tabular-nums"
          data-testid="budget-percent"
        >
          {m.budgets_percent_used({ percent })}
        </span>
      </div>

      <dl className="mt-3 grid grid-cols-3 gap-3 text-sm">
        <div>
          <dt className="text-xs text-muted-foreground">
            {m.budgets_limit_column()}
          </dt>
          <dd className="font-medium tabular-nums" data-testid="budget-limit">
            {money(budget.limitMinor)}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">
            {m.budgets_spent_label()}
          </dt>
          <dd className="font-medium tabular-nums" data-testid="budget-spent">
            {money(budget.spentMinor)}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">
            {budget.isOver ? m.budgets_over_by_label() : m.budgets_left_label()}
          </dt>
          <dd
            className={`font-medium tabular-nums ${
              budget.isOver ? "text-destructive" : ""
            }`}
            data-testid="budget-remaining"
          >
            {money(Math.abs(budget.remainingMinor))}
          </dd>
        </div>
      </dl>
    </li>
  );
}

// --- Budget Form Modal ---

interface BudgetFormData {
  categoryId: string;
  limitMinor: number;
}

function BudgetForm({
  isOpen,
  editingBudget,
  categoryOptions,
  submitting,
  onClose,
  onSubmit,
  error,
}: {
  isOpen: boolean;
  editingBudget: BudgetRow | null;
  categoryOptions: CategoryOption[];
  submitting: boolean;
  onClose: () => void;
  onSubmit: (data: BudgetFormData) => void;
  error: string | null;
}) {
  const [categoryId, setCategoryId] = useState("");
  const [limit, setLimit] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      setCategoryId(editingBudget?.categoryId ?? "");
      setLimit(editingBudget ? formatMinor(editingBudget.limitMinor) : "");
      setValidationError(null);
    }
  }, [isOpen, editingBudget]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!categoryId) {
      setValidationError(m.budgets_category_required());
      return;
    }
    const parsed = parseLimit(limit);
    if (!parsed.ok) {
      setValidationError(parsed.message);
      return;
    }
    setValidationError(null);
    onSubmit({ categoryId, limitMinor: parsed.minor });
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {editingBudget ? m.budgets_edit_title() : m.budgets_add()}
          </DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          {/* Category */}
          <div>
            <Label htmlFor="budget-category" className="mb-1">
              {m.category_label()}
            </Label>
            {editingBudget ? (
              <Select id="budget-category" value={categoryId} disabled>
                <SelectItem value={editingBudget.categoryId}>
                  {categoryLabel(
                    editingBudget.categoryName,
                    editingBudget.parentCategoryName,
                  )}
                </SelectItem>
              </Select>
            ) : (
              <Select
                id="budget-category"
                value={categoryId}
                onChange={(e) => setCategoryId(e.target.value)}
                autoFocus
              >
                <SelectItem value="">
                  {m.select_category_placeholder()}
                </SelectItem>
                {categoryOptions.map((option) => (
                  <SelectItem key={option.id} value={option.id}>
                    {option.label}
                  </SelectItem>
                ))}
              </Select>
            )}
          </div>

          {/* Monthly limit */}
          <div>
            <Label htmlFor="budget-limit" className="mb-1">
              {m.budgets_limit_label()}
            </Label>
            <Input
              id="budget-limit"
              type="text"
              inputMode="decimal"
              autoComplete="off"
              value={limit}
              onChange={(e) => setLimit(e.target.value)}
              placeholder={m.zero_amount()}
              aria-describedby="budget-limit-hint"
              aria-invalid={validationError ? true : undefined}
              autoFocus={!!editingBudget}
            />
            <p
              id="budget-limit-hint"
              className="text-xs text-muted-foreground mt-1"
            >
              {m.budgets_limit_hint()}
            </p>
          </div>

          {/* Error */}
          {error && (
            <div className="text-destructive text-sm" role="alert">
              {error}
            </div>
          )}
          {validationError && (
            <div className="text-destructive text-sm" role="alert">
              {validationError}
            </div>
          )}

          {/* Actions */}
          <DialogFooter className="pt-2">
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              disabled={submitting}
            >
              {m.cancel()}
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting
                ? editingBudget
                  ? m.saving()
                  : m.creating()
                : editingBudget
                  ? m.save_changes()
                  : m.budgets_create_btn()}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// --- Delete Confirmation ---

function DeleteConfirm({
  isOpen,
  categoryName,
  error,
  onConfirm,
  onCancel,
}: {
  isOpen: boolean;
  categoryName: string;
  error: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <AlertDialog open={isOpen} onOpenChange={(open) => !open && onCancel()}>
      <AlertDialogContent className="sm:max-w-sm">
        <AlertDialogHeader>
          <AlertDialogTitle>{m.budgets_delete_title()}</AlertDialogTitle>
          <AlertDialogDescription>
            {m.budgets_delete_confirm({ name: categoryName })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error && (
          <div
            className="text-destructive text-sm p-3 rounded-md bg-destructive/10"
            role="alert"
          >
            {error}
          </div>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onCancel}>{m.cancel()}</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={(e) => {
              // Keep the dialog open until the server confirms the delete.
              e.preventDefault();
              onConfirm();
            }}
          >
            {m.delete()}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// --- Main Page ---

function BudgetsPage() {
  const queryClient = useQueryClient();
  const getBudgetsFn = useServerFn(getBudgets);
  const getCategoriesFn = useServerFn(getCategories);
  const createBudgetFn = useServerFn(createBudget);
  const updateBudgetFn = useServerFn(updateBudget);
  const deleteBudgetFn = useServerFn(deleteBudget);

  const {
    data,
    isLoading: budgetsLoading,
    isError,
    refetch,
  } = useQuery({
    queryKey: BUDGETS_QUERY_KEY,
    queryFn: () => getBudgetsFn(),
    // Spent amounts change whenever transactions change elsewhere in the app.
    refetchOnMount: "always",
  });

  const { data: categories = [], isLoading: categoriesLoading } = useQuery({
    queryKey: CATEGORIES_QUERY_KEY,
    queryFn: () => getCategoriesFn(),
  });

  // Invalidate on error results too: "already exists" and "limit reached"
  // both mean the list on screen is stale.
  const invalidateBudgets = () =>
    queryClient.invalidateQueries({ queryKey: BUDGETS_QUERY_KEY });

  const createMutation = useMutation({
    mutationFn: (input: { categoryId: string; limitMinor: number }) =>
      createBudgetFn({ data: input }),
    onSettled: invalidateBudgets,
  });

  const updateMutation = useMutation({
    mutationFn: (input: { id: string; limitMinor: number }) =>
      updateBudgetFn({ data: input }),
    onSettled: invalidateBudgets,
  });

  const deleteMutation = useMutation({
    mutationFn: (input: { id: string }) => deleteBudgetFn({ data: input }),
    onSettled: invalidateBudgets,
  });

  // Form state
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingBudget, setEditingBudget] = useState<BudgetRow | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  // Delete state
  const [deletingBudget, setDeletingBudget] = useState<BudgetRow | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const budgets = data?.budgets ?? [];
  const maxBudgets = data?.maxBudgets ?? null;
  const isLoading = budgetsLoading || categoriesLoading;

  // Only categories without a budget can get one.
  const budgetedCategoryIds = new Set(budgets.map((b) => b.categoryId));
  const categoryNameById = new Map(categories.map((c) => [c.id, c.name]));
  const categoryOptions: CategoryOption[] = categories
    .filter((c) => !budgetedCategoryIds.has(c.id))
    .map((c) => ({
      id: c.id,
      label: categoryLabel(
        c.name,
        c.parent_id ? (categoryNameById.get(c.parent_id) ?? null) : null,
      ),
    }))
    .sort((a, b) => a.label.localeCompare(b.label));

  const hasCategories = categories.length > 0;
  const limitReached = maxBudgets !== null && budgets.length >= maxBudgets;
  const canAdd =
    !isLoading && !isError && !limitReached && categoryOptions.length > 0;

  const handleAdd = () => {
    setEditingBudget(null);
    setFormError(null);
    setIsFormOpen(true);
  };

  const handleEdit = (budget: BudgetRow) => {
    setEditingBudget(budget);
    setFormError(null);
    setIsFormOpen(true);
  };

  const closeForm = () => {
    setIsFormOpen(false);
    setEditingBudget(null);
    setFormError(null);
  };

  const handleFormSubmit = async (form: BudgetFormData) => {
    setFormError(null);
    try {
      const result = editingBudget
        ? await updateMutation.mutateAsync({
            id: editingBudget.id,
            limitMinor: form.limitMinor,
          })
        : await createMutation.mutateAsync({
            categoryId: form.categoryId,
            limitMinor: form.limitMinor,
          });
      if ("error" in result) {
        setFormError(mutationErrorMessage(result));
        return;
      }
      closeForm();
    } catch {
      setFormError(m.budgets_error_generic());
    }
  };

  const handleDeleteClick = (budget: BudgetRow) => {
    setDeletingBudget(budget);
    setDeleteError(null);
  };

  const closeDelete = () => {
    setDeletingBudget(null);
    setDeleteError(null);
  };

  const handleDeleteConfirm = async () => {
    if (!deletingBudget) return;
    setDeleteError(null);
    try {
      const result = await deleteMutation.mutateAsync({
        id: deletingBudget.id,
      });
      // Already gone on the server is the outcome the user asked for.
      if ("error" in result && result.code !== "budget_not_found") {
        setDeleteError(mutationErrorMessage(result));
        return;
      }
      closeDelete();
    } catch {
      setDeleteError(m.budgets_error_generic());
    }
  };

  return (
    <div className="min-h-screen">
      {/* Header */}
      <header className="border-b border-line/50 bg-header-bg/80 backdrop-blur-sm">
        <div className="page-wrap py-4 flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold display-title">
              {m.budgets_title()}
            </h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              {m.budgets_subtitle()}
            </p>
          </div>
          <Button onClick={handleAdd} disabled={!canAdd}>
            <svg
              className="size-4"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M12 4v16m8-8H4"
              />
            </svg>
            {m.budgets_add()}
          </Button>
        </div>
      </header>

      {/* Main Content */}
      <main className="page-wrap py-8">
        {isLoading ? (
          <div className="flex items-center justify-center py-16">
            <div className="flex flex-col items-center gap-3">
              <div className="size-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
              <span className="text-sm text-muted-foreground">
                {m.loading()}
              </span>
            </div>
          </div>
        ) : isError || !data ? (
          <div
            className="p-3 rounded-md bg-destructive/10 text-destructive text-sm flex items-center justify-between gap-3"
            role="alert"
          >
            <span>{m.budgets_load_error()}</span>
            <Button variant="outline" size="sm" onClick={() => refetch()}>
              {m.budgets_retry()}
            </Button>
          </div>
        ) : (
          <>
            {/* Month + plan usage */}
            <div className="mb-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-sm text-muted-foreground">
              <p data-testid="budgets-month">
                {m.budgets_month_note({ month: formatMonthLabel(data.month) })}
              </p>
              {maxBudgets !== null && (
                <p className="tabular-nums" data-testid="budgets-usage">
                  {m.budgets_usage({ used: budgets.length, limit: maxBudgets })}
                </p>
              )}
            </div>

            {/* Plan limit reached */}
            {limitReached && maxBudgets !== null && (
              <div
                className="mb-4 rounded-md border border-line bg-muted/40 px-4 py-3 text-sm flex flex-wrap items-center justify-between gap-3"
                role="status"
                data-testid="budgets-limit-reached"
              >
                <span>{m.budgets_limit_reached({ limit: maxBudgets })}</span>
                <Link
                  to="/billing"
                  className="font-medium text-primary underline-offset-4 hover:underline"
                >
                  {m.budgets_upgrade_link()}
                </Link>
              </div>
            )}

            {/* Nothing left to budget */}
            {!limitReached && hasCategories && categoryOptions.length === 0 && (
              <p
                className="mb-4 text-sm text-muted-foreground"
                data-testid="budgets-all-categories-used"
              >
                {m.budgets_all_categories_used()}
              </p>
            )}

            {budgets.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-center">
                <svg
                  className="size-12 text-muted-foreground/40 mb-3"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={1.5}
                  aria-hidden="true"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M10.5 6a7.5 7.5 0 107.5 7.5h-7.5V6z"
                  />
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M13.5 10.5H21A7.5 7.5 0 0013.5 3v7.5z"
                  />
                </svg>
                <h3 className="text-base font-medium mb-1">
                  {m.budgets_empty_title()}
                </h3>
                {hasCategories ? (
                  <p className="text-sm text-muted-foreground mb-4 max-w-sm">
                    {m.budgets_empty_desc()}
                  </p>
                ) : (
                  <p
                    className="text-sm text-muted-foreground mb-4 max-w-sm"
                    data-testid="budgets-no-categories"
                  >
                    {m.budgets_no_categories()}{" "}
                    <Link
                      to="/categories"
                      className="font-medium text-primary underline-offset-4 hover:underline"
                    >
                      {m.budgets_no_categories_link()}
                    </Link>
                  </p>
                )}
              </div>
            ) : (
              <div className="island-shell rounded-xl overflow-hidden">
                <ul
                  role="list"
                  aria-label={m.budgets_list_label()}
                  className="divide-y divide-line/30"
                >
                  {budgets.map((budget) => (
                    <BudgetItem
                      key={budget.id}
                      budget={budget}
                      onEdit={handleEdit}
                      onDelete={handleDeleteClick}
                    />
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </main>

      {/* Add/Edit Form */}
      <BudgetForm
        isOpen={isFormOpen}
        editingBudget={editingBudget}
        categoryOptions={categoryOptions}
        submitting={createMutation.isPending || updateMutation.isPending}
        onClose={closeForm}
        onSubmit={handleFormSubmit}
        error={formError}
      />

      {/* Delete Confirmation */}
      <DeleteConfirm
        isOpen={!!deletingBudget}
        categoryName={
          deletingBudget
            ? categoryLabel(
                deletingBudget.categoryName,
                deletingBudget.parentCategoryName,
              )
            : ""
        }
        error={deleteError}
        onConfirm={handleDeleteConfirm}
        onCancel={closeDelete}
      />
    </div>
  );
}
