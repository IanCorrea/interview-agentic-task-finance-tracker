import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  // Specs other than setup get a fresh, isolated user per test, so they run
  // in parallel. The setup project stays serial because it exercises the
  // global "no users yet" redirect.
  // Locally the default (half the CPU cores) overloads the single production
  // server on modest machines and tests die on 30s timeouts; 2 is reliable.
  workers: process.env.CI ? 4 : 2,
  reporter: "html",
  use: {
    baseURL: "http://127.0.0.1:3000",
    trace: "on-first-retry",
    // Pin the browser timezone so date assertions do not depend on the
    // machine running the tests (the transaction list formats dates in the
    // browser's local timezone).
    timezoneId: "UTC",
  },
  projects: [
    {
      // Setup specs exercise the global "are there any users yet?" redirect
      // logic, so they must run before any other spec creates a user. They
      // run serially (see test.describe.serial in setup.spec.ts) and the
      // chromium project depends on this finishing.
      name: "setup",
      testMatch: /setup\.spec\.ts/,
      workers: 1,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "chromium",
      testIgnore: /setup\.spec\.ts/,
      dependencies: ["setup"],
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    // Production-built nitro server. `vite preview` doesn't run SSR for
    // TanStack Start, so E2E builds the app and runs the real prod server
    // — the same code path real users hit.
    command: "pnpm run preview",
    url: "http://127.0.0.1:3000",
    env: {
      // Build needs NODE_ENV=production so React Compiler emits prod JSX;
      // the runtime checks TEST_MODE=1 to switch the DB to in-memory PGlite
      // and enable the test-only endpoints. Decoupled so the prod bundle is
      // the real one users hit.
      TEST_MODE: "1",
      HOST: "127.0.0.1",
      PORT: "3000",
      AI_FAKE: "1",
      AI_API_KEY: "test-key",
      // Email links inside captured test emails must point at the same
      // origin the browser drives.
      APP_BASE_URL: "http://127.0.0.1:3000",
    },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 180_000,
    reuseExistingServer: false, // We don't want to reuse existing server to avoid writing to the live database! Agents: ask the user to close the server if it's open.
  },
});
