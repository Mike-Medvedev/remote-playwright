/**
 * Logs into Facebook, navigates to Marketplace, captures a GraphQL request
 * that includes the Cookie header and a non-empty POST body, and POSTs it to WEBHOOK_URL.
 *
 * Keeps looking until a fully-valid request is found (cookie + body + lsd preferred),
 * rather than failing on the first incomplete match.
 *
 * Requires: npm install playwright
 * Run: FACEBOOK_EMAIL=... FACEBOOK_PASSWORD=... WEBHOOK_URL=... node scripts/refresh-session-playwright.js
 */
import { chromium } from "playwright";

const email = process.env.FACEBOOK_EMAIL ?? "";
const password = process.env.FACEBOOK_PASSWORD ?? "";
const webhookUrl = process.env.WEBHOOK_URL ?? "";
const CAPTURE_TIMEOUT_MS = Number(process.env.CAPTURE_TIMEOUT_MS) || 30_000;

// Playwright normalises header names to lowercase, but guard both casings defensively.
function hasCookie(headers) {
  const c = headers["cookie"] ?? headers["Cookie"] ?? "";
  return c.trim().length > 0;
}

function extractLsd(body) {
  if (!body) return null;
  try {
    return new URLSearchParams(body).get("lsd");
  } catch {
    return null;
  }
}

function isUsableRequest(request) {
  if (!request.url().includes("facebook.com/api/graphql")) return false;
  if (request.method() !== "POST") return false;

  const headers = request.headers();
  if (!hasCookie(headers)) {
    console.log("[script] Skip: GraphQL request has no Cookie header");
    return false;
  }

  const body = request.postData() ?? undefined;
  if (!body || !body.trim()) {
    console.log("[script] Skip: GraphQL request has cookie but empty body");
    return false;
  }

  const lsd = extractLsd(body);
  if (!lsd) {
    // Warn but still accept — x-fb-lsd in headers may cover this downstream.
    console.log(
      "[script] Warn: GraphQL request has cookie + body but no lsd token in body",
    );
  }

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
        console.log("[Facebook login] Clicking login button");
        await loginBtn.click();
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
        "[script] FACEBOOK_EMAIL/FACEBOOK_PASSWORD not set — complete login manually via noVNC.",
      );
    }

    console.log(
      "[script] Waiting for login to complete (handle any CAPTCHA via noVNC)...",
    );
    await page.waitForURL(
      (url) => /^https:\/\/www\.facebook\.com\/?$/.test(url.toString()),
      { timeout: 10 * 60 * 1_000 },
    );
    console.log("[script] Login detected! Navigating to Marketplace...");

    const sessionData = await new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        cleanup();
        reject(
          new Error(
            `No valid GraphQL request (cookie + body) captured within ${CAPTURE_TIMEOUT_MS}ms. ` +
              `Ensure the page has made a logged-in request.`,
          ),
        );
      }, CAPTURE_TIMEOUT_MS);

      const handler = (request) => {
        if (!isUsableRequest(request)) return;

        const headers = request.headers();
        const body = request.postData();

        console.log(
          "[script] Captured valid GraphQL request with cookie + body.",
        );
        cleanup();
        resolve({ headers, body });
      };

      const cleanup = () => {
        clearTimeout(timeoutId);
        page.off("request", handler);
      };

      page.on("request", handler);

      page
        .goto("https://www.facebook.com/marketplace/", {
          waitUntil: "domcontentloaded",
        })
        .catch(() => {});
    });

    console.log("[script] Sending session to webhook...");
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
  } catch (err) {
    console.error("[script]", err);
    process.exit(1);
  } finally {
    console.log("[script] Done. Closing browser.");
    await browser.close();
  }
}

main();
