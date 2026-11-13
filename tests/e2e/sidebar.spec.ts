import { test, expect } from "./fixtures";


test.describe("Sidebar Navigation", () => {
  test.beforeEach(async ({ page, signedInUser: _signedInUser }) => {
    await page.goto("/dashboard");
    await expect(page).toHaveURL("/dashboard");
  });

  test("sidebar navigation is visible on desktop", async ({ page }) => {
    await expect(page.getByRole("link", { name: "Dashboard" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Categories" })).toBeVisible();
    await expect(
      page
        .getByRole("navigation", { name: "Main navigation" })
        .getByRole("link", { name: "Budgets" }),
    ).toBeVisible();
  });

  test("sidebar navigation links work correctly", async ({ page }) => {
    await page.getByRole("link", { name: "Budgets" }).click();
    await expect(page).toHaveURL("/budgets");
    await expect(
      page.getByRole("heading", { name: "Budgets", exact: true }),
    ).toBeVisible();

    await page.getByRole("link", { name: "Categories" }).click();
    await expect(page).toHaveURL("/categories");
    await expect(
      page.getByRole("heading", { name: "Categories", exact: true }),
    ).toBeVisible();

    await page.getByRole("link", { name: "Dashboard" }).click();
    await expect(page).toHaveURL("/dashboard");
    await expect(
      page.getByRole("heading", { name: "Dashboard", exact: true }),
    ).toBeVisible();
  });

  test("mobile hamburger button opens sidebar", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });

    await expect(
      page.getByRole("button", { name: "Open navigation menu" }),
    ).toBeVisible();

    await page.getByRole("button", { name: "Open navigation menu" }).click();

    await expect(page.getByRole("link", { name: "Dashboard" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Categories" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Budgets" })).toBeVisible();

    await page.getByRole("button", { name: "Close sidebar" }).click();

    const sidebar = page.locator("aside");
    await expect(sidebar).toHaveClass(/-translate-x-full/);
  });
});
