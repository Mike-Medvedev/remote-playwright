/**
 * Playwright automation: headed Chromium on DISPLAY, Facebook login, then pause for manual use via noVNC.
 * Requires: DISPLAY, FACEBOOK_EMAIL, FACEBOOK_PASSWORD (env).
 */
import { chromium } from "playwright";

const email = process.env.FACEBOOK_EMAIL || "";
const password = process.env.FACEBOOK_PASSWORD || "";

async function main() {
  const browser = await chromium.launch({
    headless: false,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await page.goto("https://www.facebook.com/login/", {
      waitUntil: "domcontentloaded",
    });

    if (email && password) {
      await page.locator('input[name="email"]').waitFor({ state: "visible" });
      await page.locator('input[name="email"]').fill(email);
      await page.locator('input[name="pass"]').fill(password);

      await page.waitForTimeout(1500);

      const visibleLoginBtn = page.getByRole("button", { name: /log in/i });
      try {
        await visibleLoginBtn.waitFor({ state: "visible", timeout: 8000 });
        await visibleLoginBtn.scrollIntoViewIfNeeded();
        console.log("[Facebook login] Firing click on visible login button");
        await visibleLoginBtn.click();
      } catch {
        console.log(
          "[Facebook login] No visible button; submitting form via JS",
        );
        await page
          .locator('input[name="email"]')
          .evaluate((el) => el.form?.submit());
      }
      await page.waitForTimeout(5000);
    } else {
      console.log(
        "[script] FACEBOOK_EMAIL/FACEBOOK_PASSWORD not set; open login page for manual use.",
      );
    }

    // Pause indefinitely so you can interact via noVNC (e.g. 24h)
    console.log(
      "[script] Pausing for manual interaction via noVNC. Continue automation after timeout.",
    );
    await page.waitForTimeout(5 * 60 * 60 * 1000);
  } catch (err) {
    console.error("[script]", err);
  } finally {
    console.log("[script] Resuming automation after pause.");
    await browser.close();
  }
}

main();
