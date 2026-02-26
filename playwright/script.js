import { chromium } from "playwright";

const email = process.env.FACEBOOK_EMAIL || "";
const password = process.env.FACEBOOK_PASSWORD || "";
const webhookUrl = process.env.WEBHOOK_URL || "";

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
    } else {
      console.log(
        "[script] FACEBOOK_EMAIL/FACEBOOK_PASSWORD not set; open login page for manual use.",
      );
    }

    console.log(
      "[script] Waiting for login to complete (handle any CAPTCHA via noVNC)...",
    );
    await page.waitForURL(
      (url) =>
        url.toString() === "https://www.facebook.com/" ||
        url.toString() === "https://www.facebook.com",
      { timeout: 10 * 60 * 1000 },
    );
    console.log(
      "[script] Login detected! Navigating to marketplace to capture session...",
    );

    // Set up request listener BEFORE navigating so we don't miss anything
    const sessionData = await new Promise((resolve) => {
      page.on("request", (request) => {
        if (
          request.url().includes("facebook.com/api/graphql") &&
          request.method() === "POST" &&
          request.postData()
        ) {
          resolve({
            headers: request.headers(),
            body: request.postData(),
          });
        }
      });

      // Navigate to marketplace to trigger graphql requests
      page.goto("https://www.facebook.com/marketplace/", {
        waitUntil: "domcontentloaded",
      });
    });

    console.log("[script] Session captured, sending to webhook...");
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        headers: sessionData.headers,
        body: sessionData.body,
        capturedAt: new Date().toISOString(),
      }),
    });

    const responseText = await response.text();
    console.log(`[script] Webhook response ${response.status}:`, responseText);
  } catch (err) {
    console.error("[script]", err);
  } finally {
    console.log("[script] Done. Closing browser.");
    await browser.close();
  }
}

main();
