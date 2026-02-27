import { chromium } from "playwright";

const email = process.env.FACEBOOK_EMAIL ?? "";
const password = process.env.FACEBOOK_PASSWORD ?? "";
const webhookUrl = process.env.WEBHOOK_URL ?? "";

/**
 * The "Filter": Ensures we only capture Michael's actual Marketplace search.
 */
function isUsableRequest(request, body) {
  if (!request.url().includes("facebook.com/api/graphql")) return false;

  // 1. Identity Check (Michael)
  const isMichael = body.includes("__user=100001693381379");
  const hasAuthToken = body.includes("fb_dtsg=");

  if (!isMichael || !hasAuthToken) return false;

  // 2. Intent Check (Marketplace Search)
  const isMarketplaceSearch =
    body.includes("CometMarketplaceSearchContentContainerQuery") ||
    body.includes("MarketplaceSearchFeedPaginationQuery");

  if (isMarketplaceSearch) {
    console.log("🎯 TARGET CAPTURED: Marketplace Search Request Found!");
    return true;
  }

  // Log what we are skipping so you know it's alive
  const friendlyName =
    request.headers()["x-fb-friendly-name"] || "Unknown Query";
  console.log(
    `⏳ Auth detected, but ignoring non-marketplace query: ${friendlyName}`,
  );
  return false;
}

async function main() {
  const browser = await chromium.launch({
    headless: false,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  });

  const page = await context.newPage();

  try {
    const sessionPromise = new Promise((resolve) => {
      const handler = async (request) => {
        if (request.method() !== "POST") return;

        const body = request.postData() ?? "";

        // --- CALLING THE FUNCTION HERE ---
        if (!isUsableRequest(request, body)) return;

        // If we reach here, isUsableRequest returned true
        const cookies = await context.cookies("https://www.facebook.com");
        const cookieHeader = cookies
          .map((c) => `${c.name}=${c.value}`)
          .join("; ");

        page.off("request", handler);
        resolve({
          headers: { ...request.headers(), cookie: cookieHeader },
          body: body,
        });
      };
      page.on("request", handler);
    });

    console.log("[script] Navigating to Facebook...");
    await page.goto("https://www.facebook.com/", { waitUntil: "networkidle" });

    if (email && password) {
      console.log("[script] Filling credentials...");
      await page.fill('input[name="email"]', email);
      await page.fill('input[name="pass"]', password);
      try {
        await page
          .locator('button[name="login"], button[type="submit"]')
          .first()
          .click({ timeout: 5000 });
      } catch (e) {
        await page.keyboard.press("Enter");
      }
    }

    console.log("\n--- INSTRUCTIONS ---");
    console.log("1. Finish 2FA.");
    console.log("2. CLICK ON MARKETPLACE AND SEARCH FOR SOMETHING.");
    console.log("--------------------\n");

    const sessionData = await Promise.race([
      sessionPromise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Capture Timeout")), 300000),
      ),
    ]);

    console.log("[script] Sending to webhook...");
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(sessionData),
    });

    console.log("[script] Done!");
  } catch (err) {
    console.error("\n❌ [ERROR]", err.message);
  } finally {
    await new Promise((r) => setTimeout(r, 2000));
    await browser.close();
  }
}

main();
