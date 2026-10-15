import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "test",
  testMatch: ["webview.spec.ts", "sidebar.spec.ts"],
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:43829",
    headless: true,
    launchOptions: {
      executablePath: process.env.CHROME_PATH,
    },
  },
  webServer: {
    command: "node scripts/preview.mjs",
    url: "http://127.0.0.1:43829",
    reuseExistingServer: false,
  },
});
