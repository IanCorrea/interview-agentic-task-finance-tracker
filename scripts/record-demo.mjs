// Records a narrated (on-screen captions) walkthrough of the Monthly Budgets
// feature, one scene per acceptance criterion of TASK.md.
//
//   pnpm run build
//   node scripts/record-demo.mjs
//
// The script starts the production build itself in TEST_MODE (in-memory
// database, captured emails, test-only helper routes) on port 3000, drives a
// real Chromium through the UI and writes demo/budgets-demo.webm.
// Nothing here touches the local ./data database.

import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const BASE = "http://127.0.0.1:3000";
const OUT_DIR = path.resolve("demo");
const TMP_DIR = path.join(OUT_DIR, ".tmp");
const VIEWPORT = { width: 1280, height: 720 };

const server = spawn(process.execPath, [".output/server/index.mjs"], {
  env: {
    ...process.env,
    TEST_MODE: "1",
    HOST: "127.0.0.1",
    PORT: "3000",
    AI_FAKE: "1",
    AI_API_KEY: "test-key",
    APP_BASE_URL: BASE,
  },
  stdio: "ignore",
});

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("server did not start on port 3000");
}

const today = new Date().toISOString().slice(0, 10);
const now = new Date();
const lastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0))
  .toISOString()
  .slice(0, 10);

let browser;
try {
  await waitForServer();
  rmSync(TMP_DIR, { recursive: true, force: true });
  mkdirSync(TMP_DIR, { recursive: true });

  browser = await chromium.launch({ slowMo: 250 });
  const context = await browser.newContext({
    viewport: VIEWPORT,
    recordVideo: { dir: TMP_DIR, size: VIEWPORT },
  });
  const page = await context.newPage();

  // --- helpers -------------------------------------------------------------

  let currentCaption = "";
  const paintCaption = () =>
    page.evaluate((text) => {
      let el = document.getElementById("demo-caption");
      if (!el) {
        el = document.createElement("div");
        el.id = "demo-caption";
        el.style.cssText =
          "position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:99999;" +
          "max-width:1100px;padding:12px 22px;border-radius:12px;background:rgba(17,24,39,.94);" +
          "color:#fff;font:600 19px/1.35 system-ui,sans-serif;text-align:center;" +
          "box-shadow:0 8px 30px rgba(0,0,0,.35);pointer-events:none";
        document.body.appendChild(el);
      }
      el.textContent = text;
      el.style.display = text ? "block" : "none";
    }, currentCaption);

  /** Show a caption and hold the frame so it can be read. */
  const say = async (text, holdMs = 2600) => {
    currentCaption = text;
    await paintCaption();
    await page.waitForTimeout(holdMs);
  };
  const go = async (url) => {
    await page.goto(BASE + url);
    await page.waitForLoadState("networkidle");
    await paintCaption();
  };
  const row = (label) => page.getByRole("listitem", { name: label, exact: true });

  const addBudget = async (category, limit) => {
    await page.getByRole("button", { name: "Add Budget" }).click();
    const dialog = page.getByRole("dialog", { name: "Add Budget" });
    await dialog.getByLabel("Category").selectOption(category);
    await dialog.getByLabel("Monthly limit").fill(limit);
    await page.waitForTimeout(700);
    await dialog.getByRole("button", { name: "Create Budget" }).click();
    await row(category).waitFor();
  };

  const addTransaction = async (description, amount, category) => {
    await page
      .getByRole("banner")
      .getByRole("button", { name: "Add Transaction" })
      .click();
    const modal = page.getByRole("dialog", { name: "New Transaction" });
    await modal.getByLabel("Date").fill(`${today}T12:00`);
    await modal.getByLabel("Description").fill(description);
    await modal.getByRole("spinbutton", { name: "Amount", exact: true }).fill(amount);
    await modal.getByLabel("Account").selectOption("Main (PLN)");
    await modal.getByLabel("Category").selectOption(category);
    await page.waitForTimeout(700);
    await modal.getByRole("button", { name: "Create Transaction" }).click();
    await page.getByRole("table").getByText(description).waitFor();
  };

  const seed = async (transactions) => {
    const res = await page.request.post(`${BASE}/test-seed-transactions`, {
      data: { transactions },
    });
    if (!res.ok()) throw new Error(`seed failed: ${res.status()}`);
  };

  /** Render the emails the app actually sent (captured by the test mailer). */
  const showInbox = async (email, caption) => {
    const res = await page.request.get(
      `${BASE}/test-emails?to=${encodeURIComponent(email)}`,
    );
    const { emails } = await res.json();
    const budgetEmails = emails.filter((e) => e.subject.includes("budget"));
    const escape = (s) =>
      s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    await page.setContent(`
      <body style="margin:0;background:#f3f4f6;font:16px/1.5 system-ui,sans-serif;color:#111827">
        <div style="max-width:820px;margin:36px auto;padding:0 24px">
          <h1 style="font-size:22px;margin:0 0 4px">Inbox of ${escape(email)}</h1>
          <p style="margin:0 0 20px;color:#6b7280">Emails captured from the app's mailer (TEST_MODE) —
            over-budget alerts: <b>${budgetEmails.length}</b></p>
          ${budgetEmails
            .map(
              (e) => `
            <div style="background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:18px 22px;margin-bottom:14px">
              <div style="font-weight:700;margin-bottom:8px">${escape(e.subject)}</div>
              <pre style="margin:0;white-space:pre-wrap;font:14px/1.5 ui-monospace,monospace;color:#374151">${escape(e.text)}</pre>
            </div>`,
            )
            .join("")}
        </div>
      </body>`);
    await say(caption, 4200);
  };

  // --- scenes --------------------------------------------------------------

  const created = await page.request.post(`${BASE}/test-create-user?seed=defaults`);
  const { email } = await created.json();

  await go("/dashboard");
  await say("Monthly category budgets — demo of every acceptance criterion in TASK.md", 3200);

  await say('1. New "Budgets" page in the main navigation');
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("link", { name: "Budgets" })
    .click();
  await page.waitForLoadState("networkidle");
  await paintCaption();
  await say("Empty state, the month being shown, and the free-plan counter: 0 of 3", 3200);

  await say("2. Add a budget — the limit is validated (zero is rejected)");
  await page.getByRole("button", { name: "Add Budget" }).click();
  const addDialog = page.getByRole("dialog", { name: "Add Budget" });
  await addDialog.getByLabel("Category").selectOption("Groceries");
  await addDialog.getByLabel("Monthly limit").fill("0");
  await addDialog.getByRole("button", { name: "Create Budget" }).click();
  await page.waitForTimeout(1800);
  await addDialog.getByLabel("Monthly limit").fill("500");
  await page.waitForTimeout(600);
  await addDialog.getByRole("button", { name: "Create Budget" }).click();
  await row("Groceries").waitFor();
  await say("Each budget shows the limit, spent this month and what is left", 3200);

  await say("3. Spending counts: a 80.50 expense in Groceries, entered in the UI");
  await go("/transactions");
  await addTransaction("Supermarket", "80.50", "Groceries");
  await go("/budgets");
  await say("Spent 80.50 of 500.00 — 419.50 left", 3000);

  await seed([
    { category: "Fruits", amountMinor: -4000, date: today },
    { category: "Groceries", amountMinor: 3000, date: today },
    { category: "Groceries", amountMinor: -99900, date: lastMonth },
  ]);
  await say(
    "4. Three more transactions: 40.00 in subcategory Groceries › Fruits, a 30.00 refund, and 999.00 dated last month",
    4600,
  );
  await go("/budgets");
  await say(
    "Parent budget includes the subcategory (120.50). The refund did not reduce it. Last month does not count — budgets reset monthly.",
    5600,
  );

  await say("5. Going over a budget: Transport limited to 100.00");
  await addBudget("Transport", "100");
  await go("/transactions");
  await addTransaction("Train tickets", "150.00", "Transport");
  await go("/budgets");
  await say('Over budget is unmistakable: badge, red bar, 150% used, "Over by 50.00"', 4200);

  await showInbox(email, "6. The user got an email when the budget went over");
  await go("/transactions");
  currentCaption = "More overspending in the same month…";
  await paintCaption();
  await addTransaction("Taxi", "25.00", "Transport");
  await showInbox(email, "…still exactly one email: max one per budget per month");

  await go("/budgets");
  await say("7. Change the limit of a budget");
  await row("Groceries").getByRole("button", { name: "Edit" }).click();
  const editDialog = page.getByRole("dialog", { name: "Edit Budget" });
  await editDialog.getByLabel("Monthly limit").fill("300");
  await page.waitForTimeout(700);
  await editDialog.getByRole("button", { name: "Save Changes" }).click();
  await editDialog.waitFor({ state: "hidden" });
  await say("Limit is now 300.00 — left is recalculated", 2800);

  await say("8. Free plan: up to 3 budgets");
  await addBudget("Entertainment", "200");
  await say("3 of 3 used: adding is blocked, with an upgrade path to Pro", 4200);

  await page.request.post(`${BASE}/test-set-plan?plan=pro`);
  await go("/budgets");
  await say("After upgrading to Pro the limit is gone: unlimited budgets", 3000);
  await addBudget("Health", "250");
  await page.waitForTimeout(1200);

  await say("9. Remove a budget (with confirmation)");
  await row("Health").getByRole("button", { name: "Delete" }).click();
  const confirm = page.getByRole("alertdialog", { name: "Delete Budget" });
  await page.waitForTimeout(1400);
  await confirm.getByRole("button", { name: "Delete" }).click();
  await confirm.waitFor({ state: "hidden" });
  await page.waitForTimeout(1200);

  await say("10. Budgets are user data: included in the GDPR data export (Settings)", 2600);
  await go("/settings");
  await page.waitForTimeout(3200);

  await page.setViewportSize({ width: 420, height: 720 });
  await go("/budgets");
  await say("Works on a phone-sized screen too", 3200);

  await page.setViewportSize(VIEWPORT);
  await go("/budgets");
  await say("Done — all criteria covered by unit and end-to-end tests", 3200);

  await context.close(); // flushes the video file
  const file = readdirSync(TMP_DIR).find((f) => f.endsWith(".webm"));
  if (!file) throw new Error("no video was recorded");
  const target = path.join(OUT_DIR, "budgets-demo.webm");
  rmSync(target, { force: true });
  renameSync(path.join(TMP_DIR, file), target);
  rmSync(TMP_DIR, { recursive: true, force: true });
  console.log(`Demo recorded: ${target}`);
} finally {
  if (browser) await browser.close().catch(() => {});
  server.kill();
}
