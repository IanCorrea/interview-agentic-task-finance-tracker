import { test, expect, type Page } from "./fixtures";
import type { APIRequestContext } from "@playwright/test";
import { strFromU8, unzipSync } from "fflate";

//
// Monthly category budgets (TASK.md). Every test gets its own user from the
// `signedInUser` fixture (default categories + a "Main" PLN account), so the
// default category names are safe to reuse across parallel tests.
//
// "Spent this month" scenarios are seeded through the TEST_MODE-only
// /test-seed-transactions route, which inserts rows without running the
// over-budget alert check. Tests that assert on the alert email go through
// real write paths (the transaction form, the budget form) instead.

type CapturedEmail = { to: string; subject: string; text: string };
type SeedRow = { category: string; amountMinor: number; date: string };

const SEP = "›"; // "Parent › Child"
const LIMIT_INVALID = "Monthly limit must be a number greater than zero";
const FREE_LIMIT_MESSAGE =
  "The free plan is limited to 3 budgets. Upgrade to Pro for unlimited budgets.";

/** Today as a UTC calendar date — budgets use the UTC month. */
function utcToday(): string {
  return new Date().toISOString().slice(0, 10);
}

/** The last day of the previous UTC month. */
function lastMonthDate(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0))
    .toISOString()
    .slice(0, 10);
}

async function seedTransactions(page: Page, transactions: SeedRow[]) {
  const res = await page.request.post("/test-seed-transactions", {
    data: { transactions },
  });
  expect(res.ok()).toBe(true);
}

async function budgetEmails(
  request: APIRequestContext,
  to: string,
): Promise<CapturedEmail[]> {
  const res = await request.get(`/test-emails?to=${encodeURIComponent(to)}`);
  const { emails } = (await res.json()) as { emails: CapturedEmail[] };
  return emails.filter((e) => e.subject.includes("budget"));
}

function budgetRow(page: Page, label: string) {
  return page.getByRole("listitem", { name: label, exact: true });
}

async function openBudgets(page: Page) {
  await page.goto("/budgets");
  await expect(
    page.getByRole("heading", { name: "Budgets", exact: true, level: 1 }),
  ).toBeVisible();
  await expect(page.getByTestId("budgets-month")).toBeVisible();
}

async function addBudget(page: Page, category: string, limit: string) {
  await page.getByRole("button", { name: "Add Budget" }).click();
  const dialog = page.getByRole("dialog", { name: "Add Budget" });
  await dialog.getByLabel("Category").selectOption(category);
  await dialog.getByLabel("Monthly limit").fill(limit);
  await dialog.getByRole("button", { name: "Create Budget" }).click();
  await expect(dialog).toBeHidden();
  await expect(budgetRow(page, category)).toBeVisible();
}

async function editBudgetLimit(page: Page, label: string, limit: string) {
  await budgetRow(page, label).getByRole("button", { name: "Edit" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit Budget" });
  await dialog.getByLabel("Monthly limit").fill(limit);
  await dialog.getByRole("button", { name: "Save Changes" }).click();
  await expect(dialog).toBeHidden();
}

async function addTransactionViaUi(
  page: Page,
  opts: { description: string; amount: string; category: string },
) {
  await page
    .getByRole("banner")
    .getByRole("button", { name: "Add Transaction" })
    .click();
  const modal = page.getByRole("dialog", { name: "New Transaction" });
  await modal.getByLabel("Date").fill(`${utcToday()}T12:00`);
  await modal.getByLabel("Description").fill(opts.description);
  await modal
    .getByRole("spinbutton", { name: "Amount", exact: true })
    .fill(opts.amount);
  await modal.getByLabel("Account").selectOption("Main (PLN)");
  await modal.getByLabel("Category").selectOption(opts.category);
  await modal.getByRole("button", { name: "Create Transaction" }).click();
  await expect(modal).toBeHidden();
  // The server function awaits the alert check before it answers, so once
  // the row is listed the email (if any) has already been captured.
  await expect(
    page.getByRole("table").getByText(opts.description),
  ).toBeVisible();
}

test.describe("Budgets: navigation and empty state", () => {
  test("Budgets is in the main navigation and opens an empty page", async ({
    page,
    signedInUser: _signedInUser,
  }) => {
    await page.goto("/dashboard");
    await page
      .getByRole("navigation", { name: "Main navigation" })
      .getByRole("link", { name: "Budgets" })
      .click();

    await expect(page).toHaveURL("/budgets");
    await expect(
      page.getByRole("heading", { name: "Budgets", exact: true, level: 1 }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "No budgets yet" }),
    ).toBeVisible();
    await expect(page.getByRole("list", { name: "Budgets" })).toBeHidden();
    await expect(page.getByTestId("budgets-usage")).toHaveText(
      "0 of 3 budgets used",
    );

    const monthLabel = new Intl.DateTimeFormat("en", {
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    }).format(new Date());
    await expect(page.getByTestId("budgets-month")).toContainText(monthLabel);
    await expect(page.getByRole("button", { name: "Add Budget" })).toBeEnabled();
  });
});

test.describe("Budgets: add, edit, delete", () => {
  test.beforeEach(async ({ page, signedInUser: _signedInUser }) => {
    await openBudgets(page);
  });

  test("adds a budget, changes its limit and removes it", async ({ page }) => {
    await addBudget(page, "Groceries", "500");

    const row = budgetRow(page, "Groceries");
    await expect(row.getByTestId("budget-limit")).toHaveText("500.00 PLN");
    await expect(row.getByTestId("budget-spent")).toHaveText("0.00 PLN");
    await expect(row.getByTestId("budget-remaining")).toHaveText("500.00 PLN");
    await expect(row.getByTestId("budget-percent")).toHaveText("0% used");
    await expect(row).toHaveAttribute("data-over", "false");
    await expect(page.getByTestId("budgets-usage")).toHaveText(
      "1 of 3 budgets used",
    );

    // Edit: category is fixed, the limit is pre-filled.
    await row.getByRole("button", { name: "Edit" }).click();
    const edit = page.getByRole("dialog", { name: "Edit Budget" });
    await expect(edit.getByLabel("Category")).toBeDisabled();
    await expect(edit.getByLabel("Monthly limit")).toHaveValue("500.00");
    await edit.getByLabel("Monthly limit").fill("750.50");
    await edit.getByRole("button", { name: "Save Changes" }).click();
    await expect(edit).toBeHidden();
    await expect(row.getByTestId("budget-limit")).toHaveText("750.50 PLN");

    // The change is stored server-side.
    await page.reload();
    await expect(row.getByTestId("budget-limit")).toHaveText("750.50 PLN");

    // Cancelling the confirmation keeps the budget.
    await row.getByRole("button", { name: "Delete" }).click();
    const confirm = page.getByRole("alertdialog", { name: "Delete Budget" });
    await confirm.getByRole("button", { name: "Cancel" }).click();
    await expect(confirm).toBeHidden();
    await expect(row).toBeVisible();

    await row.getByRole("button", { name: "Delete" }).click();
    await confirm.getByRole("button", { name: "Delete" }).click();
    await expect(confirm).toBeHidden();
    await expect(row).toBeHidden();
    await expect(
      page.getByRole("heading", { name: "No budgets yet" }),
    ).toBeVisible();

    await page.reload();
    await expect(
      page.getByRole("heading", { name: "No budgets yet" }),
    ).toBeVisible();
  });

  test("cancelling the add dialog creates nothing", async ({ page }) => {
    await page.getByRole("button", { name: "Add Budget" }).click();
    const dialog = page.getByRole("dialog", { name: "Add Budget" });
    await dialog.getByLabel("Category").selectOption("Housing");
    await dialog.getByLabel("Monthly limit").fill("100");
    await dialog.getByRole("button", { name: "Cancel" }).click();

    await expect(dialog).toBeHidden();
    await expect(
      page.getByRole("heading", { name: "No budgets yet" }),
    ).toBeVisible();
  });

  test("rejects a missing category and empty, zero, negative or non-numeric limits", async ({
    page,
  }) => {
    await page.getByRole("button", { name: "Add Budget" }).click();
    const dialog = page.getByRole("dialog", { name: "Add Budget" });
    const submit = dialog.getByRole("button", { name: "Create Budget" });

    await dialog.getByLabel("Monthly limit").fill("100");
    await submit.click();
    await expect(dialog.getByRole("alert")).toHaveText("Category is required");

    await dialog.getByLabel("Category").selectOption("Housing");
    for (const bad of ["", "0", "-50", "abc"]) {
      await dialog.getByLabel("Monthly limit").fill(bad);
      await submit.click();
      await expect(dialog.getByRole("alert")).toHaveText(LIMIT_INVALID);
      await expect(dialog).toBeVisible();
    }

    // Nothing was created by any of the rejected attempts.
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "No budgets yet" }),
    ).toBeVisible();
  });

  test("rejects a zero limit when editing and keeps the old limit", async ({
    page,
  }) => {
    await addBudget(page, "Housing", "300");
    const row = budgetRow(page, "Housing");

    await row.getByRole("button", { name: "Edit" }).click();
    const edit = page.getByRole("dialog", { name: "Edit Budget" });
    await edit.getByLabel("Monthly limit").fill("0");
    await edit.getByRole("button", { name: "Save Changes" }).click();
    await expect(edit.getByRole("alert")).toHaveText(LIMIT_INVALID);
    await edit.getByRole("button", { name: "Cancel" }).click();

    await expect(row.getByTestId("budget-limit")).toHaveText("300.00 PLN");
  });

  test("a category cannot get two budgets", async ({ page, context }) => {
    // A second tab has the form open for the same category (stale data).
    const stale = await context.newPage();
    await stale.goto("/budgets");
    await stale.getByRole("button", { name: "Add Budget" }).click();
    const staleDialog = stale.getByRole("dialog", { name: "Add Budget" });
    await staleDialog.getByLabel("Category").selectOption("Transfers");
    await staleDialog.getByLabel("Monthly limit").fill("200");

    await addBudget(page, "Transfers", "100");

    // The UI no longer offers the category...
    await page.getByRole("button", { name: "Add Budget" }).click();
    const dialog = page.getByRole("dialog", { name: "Add Budget" });
    await expect(
      dialog.getByLabel("Category").getByRole("option", { name: "Housing", exact: true }),
    ).toBeAttached();
    await expect(
      dialog.getByLabel("Category").getByRole("option", { name: "Transfers", exact: true }),
    ).toHaveCount(0);
    await dialog.getByRole("button", { name: "Cancel" }).click();

    // ...and the server rejects the stale tab's attempt.
    await staleDialog.getByRole("button", { name: "Create Budget" }).click();
    await expect(staleDialog.getByRole("alert")).toHaveText(
      "This category already has a budget.",
    );

    await page.reload();
    await expect(page.getByTestId("budget-row")).toHaveCount(1);
    await expect(
      budgetRow(page, "Transfers").getByTestId("budget-limit"),
    ).toHaveText("100.00 PLN");
  });
});

test.describe("Budgets: spent, left and over budget", () => {
  test("shows limit, spent and left, and flags a budget only when spending exceeds the limit", async ({
    page,
    signedInUser: _signedInUser,
  }) => {
    await seedTransactions(page, [
      { category: "Transfers", amountMinor: -12050, date: utcToday() },
    ]);
    await openBudgets(page);
    await addBudget(page, "Transfers", "200");

    const row = budgetRow(page, "Transfers");
    await expect(row.getByTestId("budget-limit")).toHaveText("200.00 PLN");
    await expect(row.getByTestId("budget-spent")).toHaveText("120.50 PLN");
    await expect(row.getByTestId("budget-remaining")).toHaveText("79.50 PLN");
    await expect(row.getByTestId("budget-percent")).toHaveText("60% used");
    await expect(row.getByText("Left", { exact: true })).toBeVisible();
    await expect(row).toHaveAttribute("data-over", "false");
    await expect(row.getByTestId("budget-over-badge")).toBeHidden();
    await expect(
      row.getByRole("progressbar", { name: "Budget used for Transfers" }),
    ).toHaveAttribute("aria-valuenow", "60");

    // Spending exactly the limit is still within budget.
    await editBudgetLimit(page, "Transfers", "120.50");
    await expect(row.getByTestId("budget-remaining")).toHaveText("0.00 PLN");
    await expect(row).toHaveAttribute("data-over", "false");
    await expect(row.getByTestId("budget-over-badge")).toBeHidden();

    // Below the amount spent: clearly over budget.
    await editBudgetLimit(page, "Transfers", "100");
    await expect(row).toHaveAttribute("data-over", "true");
    await expect(row.getByTestId("budget-over-badge")).toHaveText(
      "Over budget",
    );
    await expect(row.getByText("Over by", { exact: true })).toBeVisible();
    await expect(row.getByTestId("budget-remaining")).toHaveText("20.50 PLN");
    await expect(row.getByTestId("budget-spent")).toHaveText("120.50 PLN");
  });

  test("a parent budget includes subcategory spending, a subcategory budget does not include the parent's", async ({
    page,
    signedInUser: _signedInUser,
  }) => {
    await seedTransactions(page, [
      { category: "Groceries", amountMinor: -6000, date: utcToday() },
      { category: "Vegetables", amountMinor: -4000, date: utcToday() },
      { category: "Fruits", amountMinor: -1525, date: utcToday() },
      // Unrelated category — must not leak into either budget.
      { category: "Fuel", amountMinor: -9900, date: utcToday() },
    ]);
    await openBudgets(page);
    await addBudget(page, "Groceries", "300");
    await addBudget(page, `Groceries ${SEP} Vegetables`, "50");

    const parent = budgetRow(page, "Groceries");
    await expect(parent.getByTestId("budget-spent")).toHaveText("115.25 PLN");
    await expect(parent.getByTestId("budget-remaining")).toHaveText(
      "184.75 PLN",
    );

    const child = budgetRow(page, `Groceries ${SEP} Vegetables`);
    await expect(child.getByTestId("budget-spent")).toHaveText("40.00 PLN");
    await expect(child.getByTestId("budget-remaining")).toHaveText("10.00 PLN");
  });

  test("income and refunds in the category do not reduce the spent amount", async ({
    page,
    signedInUser: _signedInUser,
  }) => {
    await seedTransactions(page, [
      { category: "Shopping", amountMinor: -8000, date: utcToday() },
      { category: "Shopping", amountMinor: 5000, date: utcToday() },
      { category: "Clothing", amountMinor: 2500, date: utcToday() },
    ]);
    await openBudgets(page);
    await addBudget(page, "Shopping", "100");

    const row = budgetRow(page, "Shopping");
    await expect(row.getByTestId("budget-spent")).toHaveText("80.00 PLN");
    await expect(row.getByTestId("budget-remaining")).toHaveText("20.00 PLN");
    await expect(row).toHaveAttribute("data-over", "false");
  });

  test("spending dated last month does not count towards this month", async ({
    page,
    signedInUser: _signedInUser,
  }) => {
    await seedTransactions(page, [
      { category: "Health", amountMinor: -99900, date: lastMonthDate() },
      { category: "Health", amountMinor: -2500, date: utcToday() },
    ]);
    await openBudgets(page);
    await addBudget(page, "Health", "100");

    const row = budgetRow(page, "Health");
    await expect(row.getByTestId("budget-spent")).toHaveText("25.00 PLN");
    await expect(row.getByTestId("budget-remaining")).toHaveText("75.00 PLN");
    await expect(row).toHaveAttribute("data-over", "false");
    await expect(row.getByTestId("budget-over-badge")).toBeHidden();
  });
});

test.describe("Budgets: over-budget email", () => {
  test("going over a budget sends exactly one email; more overspending sends none", async ({
    page,
    signedInUser,
  }) => {
    const email = `${signedInUser.username}@example.com`;
    const suffix = signedInUser.username;

    await openBudgets(page);
    await addBudget(page, "Transfers", "100");

    await page.goto("/transactions");

    // Within budget: no email.
    await addTransactionViaUi(page, {
      description: `Under ${suffix}`,
      amount: "60.00",
      category: "Transfers",
    });
    expect(await budgetEmails(page.request, email)).toHaveLength(0);

    // 60 + 70 = 130 > 100: the alert goes out.
    await addTransactionViaUi(page, {
      description: `Over ${suffix}`,
      amount: "70.00",
      category: "Transfers",
    });
    await expect
      .poll(async () => (await budgetEmails(page.request, email)).length)
      .toBe(1);
    const [alert] = await budgetEmails(page.request, email);
    expect(alert.to).toBe(email);
    expect(alert.subject).toBe(
      "You're over your Transfers budget — Finance Tracker",
    );
    expect(alert.text).toContain("100.00");
    expect(alert.text).toContain("130.00");
    expect(alert.text).toContain("/budgets");

    // Still over, same month: no second email.
    await addTransactionViaUi(page, {
      description: `Again ${suffix}`,
      amount: "25.00",
      category: "Transfers",
    });
    expect(await budgetEmails(page.request, email)).toHaveLength(1);

    // Nor when the limit is changed while still over.
    await openBudgets(page);
    const row = budgetRow(page, "Transfers");
    await expect(row).toHaveAttribute("data-over", "true");
    await expect(row.getByTestId("budget-spent")).toHaveText("155.00 PLN");
    await editBudgetLimit(page, "Transfers", "120");
    await expect(row.getByTestId("budget-limit")).toHaveText("120.00 PLN");
    expect(await budgetEmails(page.request, email)).toHaveLength(1);
  });
});

test.describe("Budgets: plan limits", () => {
  test("free plan blocks the 4th budget with an upgrade message; Pro can add it", async ({
    page,
    signedInUser: _signedInUser,
  }) => {
    await openBudgets(page);
    await addBudget(page, "Housing", "1000");
    await addBudget(page, "Transport", "300");
    await expect(page.getByTestId("budgets-usage")).toHaveText(
      "2 of 3 budgets used",
    );
    await expect(page.getByTestId("budgets-limit-reached")).toBeHidden();
    await addBudget(page, "Health", "200");

    await expect(page.getByTestId("budgets-usage")).toHaveText(
      "3 of 3 budgets used",
    );
    await expect(page.getByRole("button", { name: "Add Budget" })).toBeDisabled();
    const notice = page.getByTestId("budgets-limit-reached");
    await expect(notice).toContainText(FREE_LIMIT_MESSAGE);
    await expect(
      notice.getByRole("link", { name: "Upgrade to Pro" }),
    ).toHaveAttribute("href", "/billing");

    // Existing budgets stay editable at the limit.
    await editBudgetLimit(page, "Health", "250");
    await expect(
      budgetRow(page, "Health").getByTestId("budget-limit"),
    ).toHaveText("250.00 PLN");

    // Pro: unlimited.
    const res = await page.request.post("/test-set-plan?plan=pro");
    expect(res.ok()).toBe(true);
    await openBudgets(page);
    await expect(page.getByTestId("budgets-usage")).toBeHidden();
    await expect(page.getByTestId("budgets-limit-reached")).toBeHidden();
    await addBudget(page, "Shopping", "400");
    await expect(page.getByTestId("budget-row")).toHaveCount(4);
  });

  test("the free limit is enforced by the server, not only by the disabled button", async ({
    page,
    context,
    signedInUser: _signedInUser,
  }) => {
    await openBudgets(page);
    await addBudget(page, "Housing", "1000");
    await addBudget(page, "Transport", "300");

    // A second tab opens the form while there is still room for one budget.
    const stale = await context.newPage();
    await stale.goto("/budgets");
    await stale.getByRole("button", { name: "Add Budget" }).click();
    const staleDialog = stale.getByRole("dialog", { name: "Add Budget" });
    await staleDialog.getByLabel("Category").selectOption("Shopping");
    await staleDialog.getByLabel("Monthly limit").fill("400");

    await addBudget(page, "Health", "200");

    await staleDialog.getByRole("button", { name: "Create Budget" }).click();
    await expect(staleDialog.getByRole("alert")).toHaveText(FREE_LIMIT_MESSAGE);

    await page.reload();
    await expect(page.getByTestId("budget-row")).toHaveCount(3);
    await expect(budgetRow(page, "Shopping")).toBeHidden();
  });
});

test.describe("Budgets: compliance", () => {
  test("deleting a category that has an over-budget budget still works and removes the budget", async ({
    page,
    signedInUser,
  }) => {
    const email = `${signedInUser.username}@example.com`;
    await seedTransactions(page, [
      { category: "Transfers", amountMinor: -15000, date: utcToday() },
    ]);
    await openBudgets(page);
    // Creating a budget that is already over sends the alert, so the category
    // is referenced by a budget, an alert ledger row and a transaction.
    await addBudget(page, "Transfers", "100");
    await expect(budgetRow(page, "Transfers")).toHaveAttribute(
      "data-over",
      "true",
    );
    await expect
      .poll(async () => (await budgetEmails(page.request, email)).length)
      .toBe(1);

    await page.goto("/categories");
    await page
      .getByRole("row")
      .filter({ hasText: "Transfers" })
      .getByRole("button", { name: "Delete" })
      .click();
    const confirm = page.getByRole("alertdialog", { name: "Delete Category" });
    await confirm.getByLabel("Reassign transactions to").selectOption("Shopping");
    await confirm.getByRole("button", { name: "Delete" }).click();
    await expect(confirm).toBeHidden();
    await expect(page.locator("main").getByText("Transfers")).toBeHidden();

    await openBudgets(page);
    await expect(
      page.getByRole("heading", { name: "No budgets yet" }),
    ).toBeVisible();
    await expect(page.getByTestId("budgets-usage")).toHaveText(
      "0 of 3 budgets used",
    );

    // The reassigned spending now counts for the target category.
    await addBudget(page, "Shopping", "500");
    await expect(
      budgetRow(page, "Shopping").getByTestId("budget-spent"),
    ).toHaveText("150.00 PLN");
  });

  test("data export contains budgets and the account can still be hard-deleted", async ({
    page,
    signedInUser,
  }) => {
    await seedTransactions(page, [
      { category: "Housing", amountMinor: -20000, date: utcToday() },
    ]);
    await openBudgets(page);
    // Over budget on creation, so the alert ledger has a row too.
    await addBudget(page, "Housing", "123.45");

    const res = await page.request.get("/api/export-data");
    expect(res.status()).toBe(200);
    const files = unzipSync(new Uint8Array(await res.body()));
    const json = JSON.parse(strFromU8(files["export.json"]));
    expect(json.budgets).toHaveLength(1);
    expect(json.budgets[0].limit_minor).toBe(12345);
    expect(json.budgets[0].user_id).toBe(signedInUser.userId);
    expect(json.budgetAlerts).toHaveLength(1);
    expect(files["budgets.csv"]).toBeDefined();
    expect(strFromU8(files["budgets.csv"])).toContain("Housing");

    // Account deletion: request, rewind past the grace period, sweep.
    await page.goto("/settings");
    await page.getByRole("button", { name: "Delete my account" }).click();
    await page.getByLabel("Password").fill("test-password");
    await page.getByRole("button", { name: "Request deletion" }).click();
    await expect(page.getByTestId("deletion-pending-banner")).toBeVisible();

    const backdate = await page.request.post(
      `/test-backdate?userId=${signedInUser.userId}&deletionDays=15`,
    );
    expect(backdate.ok()).toBeTruthy();
    const sweep = await page.request.post("/test-run-sweep");
    expect(sweep.ok()).toBeTruthy();

    await page.goto("/login");
    await page
      .getByLabel("Email or username")
      .fill(`${signedInUser.username}@example.com`);
    await page.getByLabel("Password").fill("test-password");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByText("Invalid credentials")).toBeVisible();
  });
});
