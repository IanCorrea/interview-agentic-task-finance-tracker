// @vitest-environment node
// Required: TanStack Start's import protection mocks server modules in jsdom (client) environment.

import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { strFromU8, unzipSync } from "fflate";
import { db, schema } from "../src/db/index.ts";
import {
  buildExportZip,
  hardDeleteUser,
  purgeExpiredAiRawResponses,
  sweepExpiredDeletions,
  toCsv,
} from "../src/server/compliance.server.ts";
import { deleteCategoryForUser } from "../src/server/categories.server.ts";
import { storage } from "../src/server/storage.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Seed a user with one row in every user-owned table plus a stored image. */
async function seedFullUser(userId: string) {
  await db.insert(schema.users).values({
    id: userId,
    username: userId,
    email: `${userId}@example.com`,
    password_hash: "x",
  });
  await db.insert(schema.accounts).values({
    id: `${userId}-acc`,
    user_id: userId,
    name: "Checking",
    currency: "PLN",
  });
  await db.insert(schema.categories).values({
    id: `${userId}-cat`,
    user_id: userId,
    name: "Groceries",
  });
  await db.insert(schema.import_batches).values({
    id: `${userId}-batch`,
    user_id: userId,
    account_id: `${userId}-acc`,
    filename: "statement.csv",
    row_count: 1,
  });
  await db.insert(schema.transactions).values({
    id: `${userId}-txn`,
    user_id: userId,
    account_id: `${userId}-acc`,
    date: "2026-07-01",
    amount_minor: -1234,
    description: "Grocery store",
    category_id: `${userId}-cat`,
    import_batch_id: `${userId}-batch`,
  });
  await db.insert(schema.categorization_rules).values({
    id: `${userId}-rule`,
    user_id: userId,
    pattern: "grocery",
    category_id: `${userId}-cat`,
  });
  await db.insert(schema.budgets).values({
    id: `${userId}-budget`,
    user_id: userId,
    category_id: `${userId}-cat`,
    limit_minor: 50000,
  });
  await db.insert(schema.budget_alerts).values({
    id: `${userId}-alert`,
    user_id: userId,
    category_id: `${userId}-cat`,
    month: "2026-07",
  });
  const imageKey = `receipts/${userId}/test.jpg`;
  await storage.put(imageKey, new Uint8Array([0xff, 0xd8, 0xff, 0x42]));
  await db.insert(schema.receipts).values({
    id: `${userId}-rcpt`,
    user_id: userId,
    transaction_id: `${userId}-txn`,
    image_path: imageKey,
    ai_raw_response: '{"items":[]}',
  });
  await db.insert(schema.receipt_items).values({
    id: `${userId}-item`,
    receipt_id: `${userId}-rcpt`,
    name: "Milk",
    total_price_minor: 599,
    category_id: `${userId}-cat`,
  });
  await db.insert(schema.ai_usage).values({
    id: `${userId}-usage`,
    user_id: userId,
    kind: "receipt_scan",
    provider: "fake",
    model: "fake",
  });
  await db.insert(schema.subscriptions).values({
    user_id: userId,
    plan: "free",
    status: "active",
  });
  return { imageKey };
}

const budgetsOf = (userId: string) =>
  db.select().from(schema.budgets).where(eq(schema.budgets.user_id, userId));
const alertsOf = (userId: string) =>
  db
    .select()
    .from(schema.budget_alerts)
    .where(eq(schema.budget_alerts.user_id, userId));

async function wipeUser(userId: string) {
  // hardDeleteUser is itself under test — clean up with it, it's idempotent.
  await hardDeleteUser(userId);
}

describe("compliance: CSV writer", () => {
  it("quotes every field and escapes embedded quotes", () => {
    const csv = toCsv(
      ["id", "name"],
      [
        ["1", 'say "hi"'],
        ["2", null],
      ],
    );
    expect(csv).toBe('"id","name"\n"1","say ""hi"""\n"2",""');
  });
});

describe("compliance: data export", () => {
  const userId = "export-test-user";
  afterEach(() => wipeUser(userId));

  it("builds a zip with export.json, CSVs, and receipt images", async () => {
    await seedFullUser(userId);
    const zip = await buildExportZip(userId);
    const files = unzipSync(zip);

    const json = JSON.parse(strFromU8(files["export.json"]));
    expect(json.user.id).toBe(userId);
    expect(json.transactions).toHaveLength(1);
    expect(json.transactions[0].amount_minor).toBe(-1234);
    expect(json.receipts).toHaveLength(1);
    expect(json.receipts[0].items).toHaveLength(1);
    expect(json.receipts[0].image_file).toBe(`receipts/${userId}-rcpt.jpg`);
    expect(json.categorizationRules).toHaveLength(1);
    expect(json.subscription.plan).toBe("free");
    expect(json.budgets).toHaveLength(1);
    expect(json.budgets[0].category_id).toBe(`${userId}-cat`);
    expect(json.budgets[0].limit_minor).toBe(50000);
    expect(json.budgetAlerts).toHaveLength(1);
    expect(json.budgetAlerts[0].month).toBe("2026-07");

    const txnCsv = strFromU8(files["transactions.csv"]);
    expect(txnCsv).toContain('"Grocery store"');
    expect(txnCsv).toContain('"-12.34"');
    expect(txnCsv).toContain('"Checking"');
    expect(strFromU8(files["receipt_items.csv"])).toContain('"Milk"');
    expect(strFromU8(files["accounts.csv"])).toContain('"Checking"');
    expect(strFromU8(files["categories.csv"])).toContain('"Groceries"');
    expect(strFromU8(files["categorization_rules.csv"])).toContain('"grocery"');
    const budgetsCsv = strFromU8(files["budgets.csv"]);
    expect(budgetsCsv.split("\n")[0]).toBe(
      '"id","category","limit","limit_minor","created_at","updated_at"',
    );
    expect(budgetsCsv).toContain(
      `"${userId}-budget","Groceries","500.00","50000"`,
    );

    expect(Array.from(files[`receipts/${userId}-rcpt.jpg`])).toEqual([
      0xff, 0xd8, 0xff, 0x42,
    ]);
  });

  it("never includes another user's budgets", async () => {
    const otherId = "export-test-other";
    await seedFullUser(userId);
    await seedFullUser(otherId);
    try {
      const files = unzipSync(await buildExportZip(userId));
      const json = JSON.parse(strFromU8(files["export.json"]));
      expect(json.budgets.map((b: { id: string }) => b.id)).toEqual([
        `${userId}-budget`,
      ]);
      expect(json.budgetAlerts.map((a: { id: string }) => a.id)).toEqual([
        `${userId}-alert`,
      ]);
      expect(strFromU8(files["budgets.csv"])).not.toContain(otherId);
    } finally {
      await wipeUser(otherId);
    }
  });
});

describe("compliance: account hard delete", () => {
  const userId = "delete-test-user";
  afterEach(() => wipeUser(userId));

  it("removes every row and the stored receipt images", async () => {
    const { imageKey } = await seedFullUser(userId);
    await hardDeleteUser(userId);

    const remaining = await Promise.all([
      db.select().from(schema.users).where(eq(schema.users.id, userId)),
      db.select().from(schema.accounts).where(eq(schema.accounts.user_id, userId)),
      db.select().from(schema.categories).where(eq(schema.categories.user_id, userId)),
      db.select().from(schema.transactions).where(eq(schema.transactions.user_id, userId)),
      db.select().from(schema.import_batches).where(eq(schema.import_batches.user_id, userId)),
      db.select().from(schema.categorization_rules).where(eq(schema.categorization_rules.user_id, userId)),
      db.select().from(schema.receipts).where(eq(schema.receipts.user_id, userId)),
      db.select().from(schema.receipt_items).where(eq(schema.receipt_items.receipt_id, `${userId}-rcpt`)),
      db.select().from(schema.ai_usage).where(eq(schema.ai_usage.user_id, userId)),
      db.select().from(schema.subscriptions).where(eq(schema.subscriptions.user_id, userId)),
      db.select().from(schema.budgets).where(eq(schema.budgets.user_id, userId)),
      db.select().from(schema.budget_alerts).where(eq(schema.budget_alerts.user_id, userId)),
    ]);
    for (const rows of remaining) {
      expect.soft(rows).toHaveLength(0);
    }
    expect(await storage.get(imageKey)).toBeNull();
  });

  it("leaves another user's budgets and alert ledger untouched", async () => {
    const otherId = "delete-test-other";
    await seedFullUser(userId);
    await seedFullUser(otherId);
    try {
      await hardDeleteUser(userId);

      expect(await budgetsOf(userId)).toHaveLength(0);
      expect(await alertsOf(userId)).toHaveLength(0);
      expect(await budgetsOf(otherId)).toHaveLength(1);
      expect(await alertsOf(otherId)).toHaveLength(1);
    } finally {
      await wipeUser(otherId);
    }
  });
});

describe("compliance: category deletion with budgets", () => {
  const userId = "catdel-test-user";
  const otherId = "catdel-test-other";
  afterEach(async () => {
    await wipeUser(userId);
    await wipeUser(otherId);
  });

  const categoriesOf = (id: string) =>
    db.select().from(schema.categories).where(eq(schema.categories.user_id, id));
  const rulesOf = (id: string) =>
    db
      .select()
      .from(schema.categorization_rules)
      .where(eq(schema.categorization_rules.user_id, id));
  const transactionCategory = async (id: string) => {
    const [txn] = await db
      .select({ category_id: schema.transactions.category_id })
      .from(schema.transactions)
      .where(eq(schema.transactions.id, id));
    return txn.category_id;
  };

  it("deletes the budgets and alert ledger of the category and its descendants", async () => {
    await seedFullUser(userId);
    await seedFullUser(otherId);
    // Child and grandchild with their own budgets, plus an unrelated category.
    await db.insert(schema.categories).values([
      { id: `${userId}-child`, user_id: userId, name: "Bakery", parent_id: `${userId}-cat` },
      { id: `${userId}-grand`, user_id: userId, name: "Bread", parent_id: `${userId}-child` },
      { id: `${userId}-keep`, user_id: userId, name: "Transport" },
    ]);
    await db.insert(schema.budgets).values([
      { id: `${userId}-b-child`, user_id: userId, category_id: `${userId}-child`, limit_minor: 100 },
      { id: `${userId}-b-grand`, user_id: userId, category_id: `${userId}-grand`, limit_minor: 200 },
      { id: `${userId}-b-keep`, user_id: userId, category_id: `${userId}-keep`, limit_minor: 300 },
    ]);
    await db.insert(schema.budget_alerts).values([
      { id: `${userId}-a-grand`, user_id: userId, category_id: `${userId}-grand`, month: "2026-07" },
      { id: `${userId}-a-keep`, user_id: userId, category_id: `${userId}-keep`, month: "2026-07" },
    ]);

    const result = await deleteCategoryForUser(userId, { id: `${userId}-cat` });
    expect(result).toEqual({ success: true });

    expect((await categoriesOf(userId)).map((c) => c.id)).toEqual([`${userId}-keep`]);
    expect((await budgetsOf(userId)).map((b) => b.id)).toEqual([`${userId}-b-keep`]);
    expect((await alertsOf(userId)).map((a) => a.id)).toEqual([`${userId}-a-keep`]);

    // Existing behaviour is preserved: transaction and receipt item are
    // uncategorized, the rule is gone.
    expect(await transactionCategory(`${userId}-txn`)).toBeNull();
    const [item] = await db
      .select()
      .from(schema.receipt_items)
      .where(eq(schema.receipt_items.id, `${userId}-item`));
    expect(item.category_id).toBeNull();
    expect(await rulesOf(userId)).toHaveLength(0);

    // The other user is untouched.
    expect(await categoriesOf(otherId)).toHaveLength(1);
    expect(await budgetsOf(otherId)).toHaveLength(1);
    expect(await alertsOf(otherId)).toHaveLength(1);
  });

  it("reassigns transactions and keeps the target category's budget", async () => {
    await seedFullUser(userId);
    await db.insert(schema.categories).values({
      id: `${userId}-keep`,
      user_id: userId,
      name: "Transport",
    });
    await db.insert(schema.budgets).values({
      id: `${userId}-b-keep`,
      user_id: userId,
      category_id: `${userId}-keep`,
      limit_minor: 300,
    });

    const result = await deleteCategoryForUser(userId, {
      id: `${userId}-cat`,
      reassignToCategoryId: `${userId}-keep`,
    });
    expect(result).toEqual({ success: true });

    expect(await transactionCategory(`${userId}-txn`)).toBe(`${userId}-keep`);
    expect((await budgetsOf(userId)).map((b) => b.id)).toEqual([`${userId}-b-keep`]);
    expect(await alertsOf(userId)).toHaveLength(0);
  });

  it("refuses to delete another user's category and leaves its data alone", async () => {
    await seedFullUser(userId);
    await seedFullUser(otherId);

    const result = await deleteCategoryForUser(userId, { id: `${otherId}-cat` });
    expect(result).toEqual({ error: "Category not found" });

    expect(await categoriesOf(otherId)).toHaveLength(1);
    expect(await budgetsOf(otherId)).toHaveLength(1);
    expect(await alertsOf(otherId)).toHaveLength(1);
    expect(await rulesOf(otherId)).toHaveLength(1);
    expect(await transactionCategory(`${otherId}-txn`)).toBe(`${otherId}-cat`);
  });

  it("rejects reassigning to a descendant or to a foreign category", async () => {
    await seedFullUser(userId);
    await seedFullUser(otherId);
    await db.insert(schema.categories).values({
      id: `${userId}-child`,
      user_id: userId,
      name: "Bakery",
      parent_id: `${userId}-cat`,
    });

    expect(
      await deleteCategoryForUser(userId, {
        id: `${userId}-cat`,
        reassignToCategoryId: `${userId}-child`,
      }),
    ).toEqual({
      error: "Cannot reassign transactions to the category being deleted",
    });
    expect(
      await deleteCategoryForUser(userId, {
        id: `${userId}-cat`,
        reassignToCategoryId: `${otherId}-cat`,
      }),
    ).toEqual({ error: "Reassignment target category does not exist" });

    expect(await categoriesOf(userId)).toHaveLength(2);
    expect(await budgetsOf(userId)).toHaveLength(1);
    expect(await transactionCategory(`${userId}-txn`)).toBe(`${userId}-cat`);
  });
});

describe("compliance: retention and grace-period sweep", () => {
  const userId = "sweep-test-user";
  afterEach(() => wipeUser(userId));

  it("purges ai_raw_response older than 90 days but keeps fresh ones", async () => {
    await seedFullUser(userId);
    await db.insert(schema.receipts).values({
      id: `${userId}-old`,
      user_id: userId,
      ai_raw_response: '{"old":true}',
      created_at: new Date(Date.now() - 91 * DAY_MS),
    });

    const purged = await purgeExpiredAiRawResponses();
    expect(purged).toBe(1);

    const receipts = await db
      .select()
      .from(schema.receipts)
      .where(eq(schema.receipts.user_id, userId));
    const old = receipts.find((r) => r.id === `${userId}-old`);
    const fresh = receipts.find((r) => r.id === `${userId}-rcpt`);
    expect(old?.ai_raw_response).toBeNull();
    expect(fresh?.ai_raw_response).toBe('{"items":[]}');
  });

  it("hard-deletes only accounts whose grace period has elapsed", async () => {
    await seedFullUser(userId);

    // Pending but inside the grace window: untouched.
    await db
      .update(schema.users)
      .set({ deletion_requested_at: new Date(Date.now() - 1 * DAY_MS) })
      .where(eq(schema.users.id, userId));
    expect(await sweepExpiredDeletions()).toBe(0);
    expect(
      await db.select().from(schema.users).where(eq(schema.users.id, userId)),
    ).toHaveLength(1);

    // Past the 14-day grace window: gone.
    await db
      .update(schema.users)
      .set({ deletion_requested_at: new Date(Date.now() - 15 * DAY_MS) })
      .where(eq(schema.users.id, userId));
    expect(await sweepExpiredDeletions()).toBe(1);
    expect(
      await db.select().from(schema.users).where(eq(schema.users.id, userId)),
    ).toHaveLength(0);
  });
});
