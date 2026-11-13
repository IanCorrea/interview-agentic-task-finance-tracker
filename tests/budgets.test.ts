// @vitest-environment node
// Required: TanStack Start's import protection mocks server modules in jsdom (client) environment.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db, schema } from "../src/db/index.ts";
import {
  MAX_BUDGET_LIMIT_MINOR,
  budgetMonth,
  createBudget,
  deleteBudget,
  getBudgetStatuses,
  updateBudgetLimit,
} from "../src/server/budgets.server.ts";
import { checkBudgetLimit } from "../src/server/billing.server.ts";
import { env } from "../src/server/env.ts";

// Real in-memory DB. Two tenants so every assertion about scoping has a
// second user's data sitting right next to the first one's.
const userA = "budgets-test-user-a";
const userB = "budgets-test-user-b";
const users = [userA, userB];

/** Mid-July 2026: "this month" is 2026-07-01 … 2026-07-31 (UTC). */
const NOW = new Date("2026-07-15T12:00:00Z");

const accountOf = (userId: string) => `${userId}-acc`;

let seq = 0;
const nextId = (prefix: string) => `budgets-test-${prefix}-${++seq}`;

async function addCategory(
  userId: string,
  name: string,
  parentId: string | null = null,
): Promise<string> {
  const id = nextId("cat");
  await db.insert(schema.categories).values({
    id,
    user_id: userId,
    name,
    parent_id: parentId,
    color: "#112233",
  });
  return id;
}

async function addTxn(
  userId: string,
  categoryId: string | null,
  amountMinor: number,
  date = "2026-07-10",
): Promise<string> {
  const id = nextId("txn");
  await db.insert(schema.transactions).values({
    id,
    user_id: userId,
    account_id: accountOf(userId),
    date,
    amount_minor: amountMinor,
    category_id: categoryId,
  });
  return id;
}

async function addBudget(
  userId: string,
  categoryId: string,
  limitMinor: number,
): Promise<string> {
  const result = await createBudget(userId, { categoryId, limitMinor }, db);
  if (!("success" in result)) {
    throw new Error(`budget not created: ${result.code}`);
  }
  return result.id;
}

const setPlan = (userId: string, plan: "free" | "pro", status = "active") =>
  db
    .insert(schema.subscriptions)
    .values({ user_id: userId, plan, status })
    .onConflictDoUpdate({
      target: schema.subscriptions.user_id,
      set: { plan, status },
    });

const budgetRows = (userId: string) =>
  db.select().from(schema.budgets).where(eq(schema.budgets.user_id, userId));

/** The single status of a user's only budget. */
async function onlyStatus(userId: string, now: Date = NOW) {
  const statuses = await getBudgetStatuses(userId, now, db);
  expect(statuses).toHaveLength(1);
  return statuses[0];
}

beforeEach(async () => {
  for (const userId of users) {
    await db.insert(schema.users).values({
      id: userId,
      username: userId,
      password_hash: "x",
    });
    await db.insert(schema.accounts).values({
      id: accountOf(userId),
      user_id: userId,
      name: "Main",
    });
  }
});

afterEach(async () => {
  await db.delete(schema.budgets).where(inArray(schema.budgets.user_id, users));
  await db
    .delete(schema.transactions)
    .where(inArray(schema.transactions.user_id, users));
  await db
    .delete(schema.categories)
    .where(inArray(schema.categories.user_id, users));
  await db
    .delete(schema.subscriptions)
    .where(inArray(schema.subscriptions.user_id, users));
  await db.delete(schema.accounts).where(inArray(schema.accounts.user_id, users));
  await db.delete(schema.users).where(inArray(schema.users.id, users));
});

describe("budgetMonth", () => {
  it("returns the UTC calendar month with an exclusive upper bound", () => {
    expect(budgetMonth(new Date("2026-07-15T12:00:00Z"))).toEqual({
      month: "2026-07",
      from: "2026-07-01",
      to: "2026-08-01",
    });
  });

  it("uses UTC at the month edges, whatever the local time zone", () => {
    expect(budgetMonth(new Date("2026-07-01T00:00:00.000Z")).month).toBe("2026-07");
    expect(budgetMonth(new Date("2026-07-31T23:59:59.999Z")).month).toBe("2026-07");
    expect(budgetMonth(new Date("2026-08-01T00:00:00.000Z")).month).toBe("2026-08");
  });

  it("rolls over the year and handles leap February", () => {
    expect(budgetMonth(new Date("2026-12-31T23:59:59Z"))).toEqual({
      month: "2026-12",
      from: "2026-12-01",
      to: "2027-01-01",
    });
    expect(budgetMonth(new Date("2028-02-29T10:00:00Z"))).toEqual({
      month: "2028-02",
      from: "2028-02-01",
      to: "2028-03-01",
    });
  });
});

describe("getBudgetStatuses — spent", () => {
  it("returns an empty list when the user has no budgets", async () => {
    const cat = await addCategory(userA, "Food");
    await addTxn(userA, cat, -5_000);
    expect(await getBudgetStatuses(userA, NOW, db)).toEqual([]);
  });

  it("is zero with the full limit remaining when nothing was spent", async () => {
    const cat = await addCategory(userA, "Food");
    const id = await addBudget(userA, cat, 40_000);
    expect(await onlyStatus(userA)).toEqual({
      id,
      categoryId: cat,
      categoryName: "Food",
      categoryColor: "#112233",
      parentCategoryName: null,
      limitMinor: 40_000,
      spentMinor: 0,
      remainingMinor: 40_000,
      isOver: false,
    });
  });

  it("counts only negative amounts; income and refunds do not reduce it", async () => {
    const cat = await addCategory(userA, "Food");
    await addBudget(userA, cat, 40_000);
    await addTxn(userA, cat, -12_050);
    await addTxn(userA, cat, -7_950);
    await addTxn(userA, cat, 5_000); // refund
    await addTxn(userA, cat, 300_000); // income
    await addTxn(userA, cat, 0);

    const status = await onlyStatus(userA);
    expect(status.spentMinor).toBe(20_000);
    expect(status.remainingMinor).toBe(20_000);
    expect(status.isOver).toBe(false);
  });

  it("stays at zero when the category only has positive transactions", async () => {
    const cat = await addCategory(userA, "Salary");
    await addBudget(userA, cat, 1_000);
    await addTxn(userA, cat, 900_000);
    const status = await onlyStatus(userA);
    expect(status.spentMinor).toBe(0);
    expect(status.remainingMinor).toBe(1_000);
  });

  it("ignores uncategorized transactions and other categories", async () => {
    const food = await addCategory(userA, "Food");
    const fun = await addCategory(userA, "Fun");
    await addBudget(userA, food, 10_000);
    await addTxn(userA, food, -1_000);
    await addTxn(userA, fun, -2_000);
    await addTxn(userA, null, -4_000);
    expect((await onlyStatus(userA)).spentMinor).toBe(1_000);
  });

  it("sums amounts beyond the 32-bit integer range without overflow", async () => {
    const cat = await addCategory(userA, "House");
    await addBudget(userA, cat, MAX_BUDGET_LIMIT_MINOR);
    await addTxn(userA, cat, -2_000_000_000);
    await addTxn(userA, cat, -2_000_000_000);
    const status = await onlyStatus(userA);
    expect(status.spentMinor).toBe(4_000_000_000);
    expect(status.remainingMinor).toBe(-2_000_000_000);
    expect(status.isOver).toBe(true);
  });
});

describe("getBudgetStatuses — category tree", () => {
  it("a parent budget includes child and grandchild spending", async () => {
    const food = await addCategory(userA, "Food");
    const groceries = await addCategory(userA, "Groceries", food);
    const bakery = await addCategory(userA, "Bakery", groceries);
    await addBudget(userA, food, 100_000);
    await addTxn(userA, food, -1_000);
    await addTxn(userA, groceries, -2_000);
    await addTxn(userA, bakery, -4_000);
    await addTxn(userA, bakery, 8_000); // refund in a descendant

    const status = await onlyStatus(userA);
    expect(status.spentMinor).toBe(7_000);
    expect(status.parentCategoryName).toBeNull();
  });

  it("a child budget excludes the parent's and a sibling's spending", async () => {
    const food = await addCategory(userA, "Food");
    const groceries = await addCategory(userA, "Groceries", food);
    const restaurants = await addCategory(userA, "Restaurants", food);
    const bakery = await addCategory(userA, "Bakery", groceries);
    await addBudget(userA, groceries, 100_000);
    await addTxn(userA, food, -1_000);
    await addTxn(userA, restaurants, -2_000);
    await addTxn(userA, groceries, -4_000);
    await addTxn(userA, bakery, -8_000);

    const status = await onlyStatus(userA);
    expect(status.spentMinor).toBe(12_000);
    expect(status.categoryName).toBe("Groceries");
    expect(status.parentCategoryName).toBe("Food");
  });

  it("parent and child budgets each report their own subtree, sorted by name", async () => {
    const food = await addCategory(userA, "Food");
    const groceries = await addCategory(userA, "Groceries", food);
    const car = await addCategory(userA, "Car");
    await addBudget(userA, groceries, 5_000);
    await addBudget(userA, food, 20_000);
    await addBudget(userA, car, 30_000);
    await addTxn(userA, food, -1_000);
    await addTxn(userA, groceries, -6_000);

    const statuses = await getBudgetStatuses(userA, NOW, db);
    expect(statuses.map((s) => [s.categoryName, s.spentMinor, s.isOver])).toEqual([
      ["Car", 0, false],
      ["Food", 7_000, false],
      ["Groceries", 6_000, true],
    ]);
  });
});

describe("getBudgetStatuses — current UTC month only", () => {
  it("includes the first and last day, excludes the previous and next month", async () => {
    const cat = await addCategory(userA, "Food");
    await addBudget(userA, cat, 100_000);
    await addTxn(userA, cat, -1, "2026-06-30");
    await addTxn(userA, cat, -10, "2026-07-01");
    await addTxn(userA, cat, -100, "2026-07-31");
    await addTxn(userA, cat, -1_000, "2026-08-01");
    await addTxn(userA, cat, -10_000, "2025-07-15"); // same month, other year

    expect((await onlyStatus(userA)).spentMinor).toBe(110);
    // Same result at both edges of the month.
    expect(
      (await onlyStatus(userA, new Date("2026-07-01T00:00:00.000Z"))).spentMinor,
    ).toBe(110);
    expect(
      (await onlyStatus(userA, new Date("2026-07-31T23:59:59.999Z"))).spentMinor,
    ).toBe(110);
  });

  it("resets when the month rolls over, keeping the limit", async () => {
    const cat = await addCategory(userA, "Food");
    await addBudget(userA, cat, 5_000);
    await addTxn(userA, cat, -9_000, "2026-07-20");

    const july = await onlyStatus(userA, new Date("2026-07-31T23:59:59.999Z"));
    expect(july).toMatchObject({ spentMinor: 9_000, isOver: true });

    const august = await onlyStatus(userA, new Date("2026-08-01T00:00:00.000Z"));
    expect(august).toMatchObject({
      limitMinor: 5_000,
      spentMinor: 0,
      remainingMinor: 5_000,
      isOver: false,
    });
  });

  it("handles the December → January boundary", async () => {
    const cat = await addCategory(userA, "Food");
    await addBudget(userA, cat, 5_000);
    await addTxn(userA, cat, -100, "2026-12-31");
    await addTxn(userA, cat, -1_000, "2027-01-01");
    expect(
      (await onlyStatus(userA, new Date("2026-12-31T23:00:00Z"))).spentMinor,
    ).toBe(100);
    expect(
      (await onlyStatus(userA, new Date("2027-01-01T00:00:00Z"))).spentMinor,
    ).toBe(1_000);
  });
});

describe("getBudgetStatuses — remaining and isOver", () => {
  it("spending exactly the limit is not over; one minor unit above is", async () => {
    const cat = await addCategory(userA, "Food");
    await addBudget(userA, cat, 10_000);

    await addTxn(userA, cat, -9_999);
    expect(await onlyStatus(userA)).toMatchObject({
      spentMinor: 9_999,
      remainingMinor: 1,
      isOver: false,
    });

    await addTxn(userA, cat, -1);
    expect(await onlyStatus(userA)).toMatchObject({
      spentMinor: 10_000,
      remainingMinor: 0,
      isOver: false,
    });

    await addTxn(userA, cat, -1);
    expect(await onlyStatus(userA)).toMatchObject({
      spentMinor: 10_001,
      remainingMinor: -1,
      isOver: true,
    });
  });

  it("a refund does not bring an over-budget category back under", async () => {
    const cat = await addCategory(userA, "Food");
    await addBudget(userA, cat, 10_000);
    await addTxn(userA, cat, -10_001);
    await addTxn(userA, cat, 10_001);
    expect(await onlyStatus(userA)).toMatchObject({
      spentMinor: 10_001,
      isOver: true,
    });
  });
});

describe("tenant isolation", () => {
  it("other users' transactions and budgets never leak", async () => {
    const catA = await addCategory(userA, "Food");
    const catB = await addCategory(userB, "Food");
    const budgetA = await addBudget(userA, catA, 10_000);
    const budgetB = await addBudget(userB, catB, 99_000);
    await addTxn(userA, catA, -1_500);
    await addTxn(userB, catB, -70_000);

    const a = await getBudgetStatuses(userA, NOW, db);
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({
      id: budgetA,
      categoryId: catA,
      limitMinor: 10_000,
      spentMinor: 1_500,
    });

    const b = await getBudgetStatuses(userB, NOW, db);
    expect(b).toHaveLength(1);
    expect(b[0]).toMatchObject({
      id: budgetB,
      categoryId: catB,
      limitMinor: 99_000,
      spentMinor: 70_000,
    });
  });

  it("a user without budgets sees nothing even when others have some", async () => {
    const catA = await addCategory(userA, "Food");
    await addBudget(userA, catA, 10_000);
    expect(await getBudgetStatuses(userB, NOW, db)).toEqual([]);
  });

  it("the plan limit counts only the user's own budgets", async () => {
    for (let i = 0; i < env.billing.freeMaxBudgets; i++) {
      await addBudget(userA, await addCategory(userA, `A${i}`), 1_000);
    }
    expect((await checkBudgetLimit(userA, db)).allowed).toBe(false);
    expect((await checkBudgetLimit(userB, db)).allowed).toBe(true);
    const result = await createBudget(
      userB,
      { categoryId: await addCategory(userB, "B"), limitMinor: 1_000 },
      db,
    );
    expect(result).toMatchObject({ success: true });
  });
});

describe("createBudget", () => {
  it("stores the budget for the user's category", async () => {
    const cat = await addCategory(userA, "Food");
    const result = await createBudget(
      userA,
      { categoryId: cat, limitMinor: 12_345 },
      db,
    );
    expect(result).toMatchObject({ success: true });
    const rows = await budgetRows(userA);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "success" in result ? result.id : "",
      user_id: userA,
      category_id: cat,
      limit_minor: 12_345,
    });
  });

  it("rejects a missing category and another user's category alike", async () => {
    const foreign = await addCategory(userB, "Theirs");
    for (const categoryId of ["no-such-category", foreign]) {
      expect(
        await createBudget(userA, { categoryId, limitMinor: 1_000 }, db),
      ).toMatchObject({ code: "category_not_found" });
    }
    expect(await budgetRows(userA)).toEqual([]);
    expect(await budgetRows(userB)).toEqual([]);
  });

  it("rejects a second budget for the same category and keeps the first", async () => {
    const cat = await addCategory(userA, "Food");
    const first = await addBudget(userA, cat, 1_000);
    expect(
      await createBudget(userA, { categoryId: cat, limitMinor: 2_000 }, db),
    ).toMatchObject({ code: "budget_exists" });
    const rows = await budgetRows(userA);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: first, limit_minor: 1_000 });
  });

  it("concurrent creates for one category produce exactly one budget", async () => {
    const cat = await addCategory(userA, "Food");
    const results = await Promise.all(
      [1_000, 2_000, 3_000].map((limitMinor) =>
        createBudget(userA, { categoryId: cat, limitMinor }, db),
      ),
    );
    expect(results.filter((r) => "success" in r)).toHaveLength(1);
    expect(
      results.filter((r) => "code" in r && r.code === "budget_exists"),
    ).toHaveLength(2);
    expect(await budgetRows(userA)).toHaveLength(1);
  });

  it("rejects invalid limits before touching the database", async () => {
    const cat = await addCategory(userA, "Food");
    const invalid = [
      0,
      -1,
      -10_000,
      10.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      MAX_BUDGET_LIMIT_MINOR + 1,
    ];
    for (const limitMinor of invalid) {
      expect(
        await createBudget(userA, { categoryId: cat, limitMinor }, db),
        String(limitMinor),
      ).toMatchObject({ code: "invalid_limit" });
    }
    expect(await budgetRows(userA)).toEqual([]);
  });

  it("accepts the smallest and the largest allowed limit", async () => {
    const small = await addCategory(userA, "Small");
    const large = await addCategory(userA, "Large");
    expect(
      await createBudget(userA, { categoryId: small, limitMinor: 1 }, db),
    ).toMatchObject({ success: true });
    expect(
      await createBudget(
        userA,
        { categoryId: large, limitMinor: MAX_BUDGET_LIMIT_MINOR },
        db,
      ),
    ).toMatchObject({ success: true });
  });

  it("free plan: blocks the budget after the limit (3 by default)", async () => {
    const freeMax = env.billing.freeMaxBudgets;
    for (let i = 0; i < freeMax; i++) {
      expect((await checkBudgetLimit(userA, db)).allowed).toBe(true);
      await addBudget(userA, await addCategory(userA, `Cat ${i}`), 1_000);
    }

    const extra = await addCategory(userA, "One too many");
    const blocked = await createBudget(
      userA,
      { categoryId: extra, limitMinor: 1_000 },
      db,
    );
    expect(blocked).toMatchObject({
      code: "budget_limit_reached",
      limit: freeMax,
    });
    expect(await budgetRows(userA)).toHaveLength(freeMax);

    // Removing one frees a slot again.
    const [first] = await budgetRows(userA);
    await deleteBudget(userA, first.id, db);
    expect(
      await createBudget(userA, { categoryId: extra, limitMinor: 1_000 }, db),
    ).toMatchObject({ success: true });
  });

  it("free plan: concurrent creates cannot exceed the limit", async () => {
    const freeMax = env.billing.freeMaxBudgets;
    const cats: string[] = [];
    for (let i = 0; i < freeMax + 3; i++) {
      cats.push(await addCategory(userA, `Cat ${i}`));
    }
    const results = await Promise.all(
      cats.map((categoryId) =>
        createBudget(userA, { categoryId, limitMinor: 1_000 }, db),
      ),
    );
    expect(results.filter((r) => "success" in r)).toHaveLength(freeMax);
    expect(
      results.filter((r) => "code" in r && r.code === "budget_limit_reached"),
    ).toHaveLength(3);
    expect(await budgetRows(userA)).toHaveLength(freeMax);
  });

  it("free plan: a duplicate category is reported as such even at the limit", async () => {
    const cats: string[] = [];
    for (let i = 0; i < env.billing.freeMaxBudgets; i++) {
      const cat = await addCategory(userA, `Cat ${i}`);
      cats.push(cat);
      await addBudget(userA, cat, 1_000);
    }
    expect(
      await createBudget(userA, { categoryId: cats[0], limitMinor: 1_000 }, db),
    ).toMatchObject({ code: "budget_exists" });
  });

  it("pro plan: unlimited budgets", async () => {
    await setPlan(userA, "pro");
    const total = env.billing.freeMaxBudgets + 3;
    for (let i = 0; i < total; i++) {
      await addBudget(userA, await addCategory(userA, `Cat ${i}`), 1_000);
    }
    expect(await budgetRows(userA)).toHaveLength(total);
    expect((await checkBudgetLimit(userA, db)).allowed).toBe(true);
  });

  it("budgets above the limit survive a downgrade; only new ones are blocked", async () => {
    await setPlan(userA, "pro");
    const total = env.billing.freeMaxBudgets + 2;
    const cats: string[] = [];
    for (let i = 0; i < total; i++) {
      const cat = await addCategory(userA, `Cat ${i}`);
      cats.push(cat);
      await addBudget(userA, cat, 1_000);
    }
    await addTxn(userA, cats[total - 1], -250);

    // Stripe's final cancellation mirrors as plan=free, status=canceled.
    await setPlan(userA, "free", "canceled");

    const statuses = await getBudgetStatuses(userA, NOW, db);
    expect(statuses).toHaveLength(total);
    expect(statuses.reduce((sum, s) => sum + s.spentMinor, 0)).toBe(250);

    expect(
      await createBudget(
        userA,
        { categoryId: await addCategory(userA, "New"), limitMinor: 1_000 },
        db,
      ),
    ).toMatchObject({ code: "budget_limit_reached" });

    // Existing budgets stay fully editable and removable.
    const rows = await budgetRows(userA);
    expect(
      await updateBudgetLimit(userA, { id: rows[0].id, limitMinor: 7_000 }, db),
    ).toMatchObject({ success: true });
    expect(await deleteBudget(userA, rows[1].id, db)).toMatchObject({
      success: true,
    });
    expect(await budgetRows(userA)).toHaveLength(total - 1);
  });
});

describe("updateBudgetLimit", () => {
  it("changes the limit and the derived remaining/isOver", async () => {
    const cat = await addCategory(userA, "Food");
    const id = await addBudget(userA, cat, 10_000);
    await addTxn(userA, cat, -6_000);

    expect(
      await updateBudgetLimit(userA, { id, limitMinor: 5_000 }, db),
    ).toEqual({ success: true, id });
    expect(await onlyStatus(userA)).toMatchObject({
      id,
      limitMinor: 5_000,
      spentMinor: 6_000,
      remainingMinor: -1_000,
      isOver: true,
    });
  });

  it("returns not found for an unknown id and changes nothing", async () => {
    const cat = await addCategory(userA, "Food");
    await addBudget(userA, cat, 10_000);
    expect(
      await updateBudgetLimit(userA, { id: "no-such-budget", limitMinor: 1 }, db),
    ).toMatchObject({ code: "budget_not_found" });
    expect((await budgetRows(userA))[0].limit_minor).toBe(10_000);
  });

  it("a cross-user attempt looks like not found and changes nothing", async () => {
    const cat = await addCategory(userA, "Food");
    const id = await addBudget(userA, cat, 10_000);
    expect(
      await updateBudgetLimit(userB, { id, limitMinor: 1 }, db),
    ).toMatchObject({ code: "budget_not_found" });
    const rows = await budgetRows(userA);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id, user_id: userA, limit_minor: 10_000 });
    expect(await budgetRows(userB)).toEqual([]);
  });

  it("rejects invalid limits and keeps the stored one", async () => {
    const cat = await addCategory(userA, "Food");
    const id = await addBudget(userA, cat, 10_000);
    for (const limitMinor of [0, -5, 1.5, Number.NaN, MAX_BUDGET_LIMIT_MINOR + 1]) {
      expect(
        await updateBudgetLimit(userA, { id, limitMinor }, db),
        String(limitMinor),
      ).toMatchObject({ code: "invalid_limit" });
    }
    expect((await budgetRows(userA))[0].limit_minor).toBe(10_000);
  });
});

describe("deleteBudget", () => {
  it("removes the budget but keeps the category and its transactions", async () => {
    const cat = await addCategory(userA, "Food");
    const id = await addBudget(userA, cat, 10_000);
    const txn = await addTxn(userA, cat, -500);

    expect(await deleteBudget(userA, id, db)).toEqual({ success: true, id });
    expect(await budgetRows(userA)).toEqual([]);
    expect(await getBudgetStatuses(userA, NOW, db)).toEqual([]);
    expect(
      await db
        .select({ id: schema.categories.id })
        .from(schema.categories)
        .where(eq(schema.categories.id, cat)),
    ).toHaveLength(1);
    expect(
      await db
        .select({ id: schema.transactions.id })
        .from(schema.transactions)
        .where(eq(schema.transactions.id, txn)),
    ).toHaveLength(1);

    // The category can get a budget again afterwards.
    expect(
      await createBudget(userA, { categoryId: cat, limitMinor: 2_000 }, db),
    ).toMatchObject({ success: true });
  });

  it("returns not found for an unknown id, including a second delete", async () => {
    const cat = await addCategory(userA, "Food");
    const id = await addBudget(userA, cat, 10_000);
    expect(await deleteBudget(userA, "no-such-budget", db)).toMatchObject({
      code: "budget_not_found",
    });
    expect(await budgetRows(userA)).toHaveLength(1);

    await deleteBudget(userA, id, db);
    expect(await deleteBudget(userA, id, db)).toMatchObject({
      code: "budget_not_found",
    });
  });

  it("a cross-user attempt looks like not found and deletes nothing", async () => {
    const cat = await addCategory(userA, "Food");
    const id = await addBudget(userA, cat, 10_000);
    expect(await deleteBudget(userB, id, db)).toMatchObject({
      code: "budget_not_found",
    });
    const rows = await budgetRows(userA);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id, limit_minor: 10_000 });
  });
});
