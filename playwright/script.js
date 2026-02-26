import { chromium } from "playwright";

const email = process.env.FACEBOOK_EMAIL ?? "";
const password = process.env.FACEBOOK_PASSWORD ?? "";
const webhookUrl = process.env.WEBHOOK_URL ?? "";

function isUsableRequest(request) {
  if (!request.url().includes("facebook.com/api/graphql")) return false;
  if (request.method() !== "POST") return false;

  const body = request.postData() ?? "";
  if (!body.trim()) return false;

  return true;
}

async function main() {
  const browser = await chromium.launch({
    headless: false,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    const sessionPromise = new Promise((resolve) => {
      const handler = async (request) => {
        if (!isUsableRequest(request)) return;

        const cookies = await context.cookies("https://www.facebook.com");
        if (!cookies.length) return;

        const cookieHeader = cookies
          .map((c) => `${c.name}=${c.value}`)
          .join("; ");
        page.off("request", handler);

        resolve({
          headers: { ...request.headers(), cookie: cookieHeader },
          body: request.postData(),
        });
      };
      page.on("request", handler);
    });

    await page.goto("https://www.facebook.com/login/", {
      waitUntil: "domcontentloaded",
    });

    if (email && password) {
      await page.locator('input[name="email"]').waitFor({ state: "visible" });
      await page.locator('input[name="email"]').fill(email);
      await page.locator('input[name="pass"]').fill(password);
      await page.waitForTimeout(1500);

      const loginBtn = page.getByRole("button", { name: /log in/i });
      try {
        await loginBtn.waitFor({ state: "visible", timeout: 8_000 });
        await loginBtn.scrollIntoViewIfNeeded();
        console.log("[script] Clicking login button...");
        await loginBtn.click();
      } catch {
        console.log("[script] No visible button; submitting form via JS");
        await page
          .locator('input[name="email"]')
          .evaluate((el) => el.form?.submit());
      }
    }

    // Wait for session — handles both instant capture and post-CAPTCHA/2FA capture.
    // The browser stays open so the user can complete any verification manually.
    console.log(
      "[script] Waiting for session capture (complete any CAPTCHA/2FA if prompted)...",
    );
    const sessionData = await Promise.race([
      sessionPromise,
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error("Capture timeout after 10 minutes")),
          10 * 60 * 1_000,
        ),
      ),
    ]);

    console.log("[script] Session captured! Sending to webhook...");
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

    if (!response.ok) {
      throw new Error(`Webhook returned ${response.status}: ${responseText}`);
    }

    console.log("[script] Done!");
  } catch (err) {
    console.error("[script]", err);
    process.exit(1);
  } finally {
    await browser.close();
  }
}

main();
