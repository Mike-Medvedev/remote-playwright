import { chromium } from "playwright";
import fs from "fs";

const WEBHOOK_URL = process.env.WEBHOOK_URL ?? "";
const NOVNC_PORT = process.env.NOVNC_PORT ?? "6080";
const LOGIN_POLL_INTERVAL_MS = 3000;
const SESSION_CAPTURE_TIMEOUT_MS = 300_000;
const TOTAL_SCRIPT_TIMEOUT_MS =
  Number(process.env.TOTAL_SCRIPT_TIMEOUT_MS) || 20 * 60 * 1000;

if (!WEBHOOK_URL) {
  console.error("ERROR: WEBHOOK_URL environment variable is required.");
  process.exit(1);
}

async function getSyncContext() {
  const endpoint = `${WEBHOOK_URL}/webhook/sync-context`;
  console.log(`[script] Fetching sync context from ${endpoint}`);
  const res = await fetch(endpoint);
  const result = await res.json();
  if (!res.ok || !result.success) {
    const msg = result.error?.message ?? result.message ?? `HTTP ${res.status}`;
    throw new Error(`sync-context failed: ${msg}`);
  }
  const data = result.data;
  if (!data?.userId) {
    throw new Error("sync-context response missing userId");
  }
  console.log(`[script] Sync context received. userId: ${data.userId}, containerHost: ${data.containerHost}`);
  return { userId: data.userId, containerHost: data.containerHost };
}

async function getPublicIp() {
  try {
    const res = await fetch(
      "http://169.254.169.254/metadata/instance?api-version=2021-02-01",
      { headers: { Metadata: "true" } },
    );
    const data = await res.json();
    return data.network.interface[0].ipv4.ipAddress[0].publicIpAddress;
  } catch {
    return process.env.CONTAINER_IP ?? "localhost";
  }
}

function isAuthenticatedGraphQL(request, body) {
  if (!request.url().includes("facebook.com/api/graphql")) return false;
  if (request.method() !== "POST") return false;
  if (!body.includes("fb_dtsg=")) return false;
  return true;
}

async function isLoggedIn(page) {
  const url = page.url();
  if (url.includes("/login") || url.includes("/checkpoint") || url.includes("/recover")) return false;

  const loginForm = await page
    .locator('form[action*="/login"], #login_form, input[name="email"]')
    .first()
    .isVisible()
    .catch(() => false);
  if (loginForm) return false;

  const loggedInIndicator = await page
    .locator(
      '[aria-label="Your profile"], [aria-label="Account"], [data-pagelet="ProfileTail"], ' +
      'a[href*="/marketplace"], [aria-label="Marketplace"], [role="navigation"]',
    )
    .first()
    .isVisible({ timeout: 8000 })
    .catch(() => false);

  return loggedInIndicator;
}

async function waitForLogin(page) {
  console.log("[script] Waiting for human to complete login...");
  while (true) {
    await new Promise((r) => setTimeout(r, LOGIN_POLL_INTERVAL_MS));

    const url = page.url();
    if (
      url.includes("/login") ||
      url.includes("/checkpoint") ||
      url.includes("/recover")
    ) {
      continue;
    }

    const loggedIn = await isLoggedIn(page);
    if (loggedIn) {
      console.log("[script] Login detected!");
      return;
    }
  }
}

async function notifyNeedsLogin(novncUrl, userId) {
  const endpoint = `${WEBHOOK_URL}/webhook/needs-login`;
  console.log(
    `[script] Notifying backend: human login required -> ${endpoint}`,
  );
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ novncUrl, userId }),
    });
    console.log(`[script] needs-login webhook response: ${res.status}`);
    if (!res.ok) {
      console.error(
        `[script] needs-login webhook failed (${res.status}): ${res.statusText}`,
      );
      process.exit(1);
    }
  } catch (err) {
    console.error(`[script] Failed to notify needs-login: ${err.message}`);
    process.exit(1);
  }
}

async function captureSession(page, context) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Session capture timed out")),
      SESSION_CAPTURE_TIMEOUT_MS,
    );

    let cookieRetryCount = 0;
    const MAX_COOKIE_RETRIES = 3;

    const handler = async (request) => {
      const body = request.postData() ?? "";
      if (!isAuthenticatedGraphQL(request, body)) return;

      const reqHeaders = request.headers();
      const friendlyName = reqHeaders["x-fb-friendly-name"] || "unknown";

      let cookieHeader = reqHeaders["cookie"] ?? "";
      if (!cookieHeader) {
        const cookies = await context.cookies("https://www.facebook.com");
        cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
      }

      if (!cookieHeader) {
        cookieRetryCount++;
        if (cookieRetryCount <= MAX_COOKIE_RETRIES) {
          console.log(
            `[script] GraphQL "${friendlyName}" has no cookies yet (attempt ${cookieRetryCount}/${MAX_COOKIE_RETRIES}), waiting for next request...`,
          );
          return;
        }
        console.log(
          `[script] GraphQL "${friendlyName}" still has no cookies after ${MAX_COOKIE_RETRIES} attempts, skipping.`,
        );
        return;
      }

      clearTimeout(timeout);
      page.off("request", handler);

      console.log(`[script] Captured authenticated GraphQL: ${friendlyName}`);
      console.log(
        `[script] Cookie source: ${reqHeaders["cookie"] ? "request header" : "browser context"}`,
      );

      resolve({
        headers: { ...reqHeaders, cookie: cookieHeader },
        body,
        capturedAt: new Date().toISOString(),
      });
    };

    page.on("request", handler);
  });
}

async function triggerMarketplaceGraphQL(page) {
  console.log("[script] Triggering marketplace GraphQL via element interactions...");

  const searchBar = page.locator(
    'input[aria-label="Search Marketplace"], input[placeholder*="Search Marketplace"], ' +
    'input[aria-label="Search Facebook"], input[placeholder*="Search Facebook"]',
  );
  const searchVisible = await searchBar.first().isVisible({ timeout: 5000 }).catch(() => false);
  if (searchVisible) {
    console.log("[script] Focusing search bar to trigger GraphQL...");
    await searchBar.first().focus().catch(() => {});
    await page.waitForTimeout(2000);
    await searchBar.first().click().catch(() => {});
    await page.waitForTimeout(2000);
  }

  const categoryLinks = page.locator(
    'a[href*="/marketplace/categories"], a[href*="/marketplace/vehicles"], ' +
    'a[href*="/marketplace/property"], [role="listitem"] a[href*="/marketplace"]',
  );
  const categoryCount = await categoryLinks.count().catch(() => 0);
  if (categoryCount > 0) {
    console.log(`[script] Hovering ${Math.min(categoryCount, 3)} category links...`);
    for (let i = 0; i < Math.min(categoryCount, 3); i++) {
      await categoryLinks.nth(i).hover({ force: true }).catch(() => {});
      await page.waitForTimeout(1500);
    }
  }

  const feedItems = page.locator(
    '[data-pagelet*="Marketplace"] a, [role="article"] a, ' +
    'a[href*="/marketplace/item/"]',
  );
  const feedCount = await feedItems.count().catch(() => 0);
  if (feedCount > 0) {
    console.log(`[script] Hovering ${Math.min(feedCount, 3)} feed items...`);
    for (let i = 0; i < Math.min(feedCount, 3); i++) {
      await feedItems.nth(i).hover({ force: true }).catch(() => {});
      await page.waitForTimeout(1500);
    }
  }

  console.log("[script] Scrolling page to trigger lazy-loaded GraphQL calls...");
  await page.evaluate(() => window.scrollBy(0, 600)).catch(() => {});
  await page.waitForTimeout(2000);
  await page.evaluate(() => window.scrollBy(0, 600)).catch(() => {});
  await page.waitForTimeout(2000);
}

async function postSession(sessionData, userId) {
  const endpoint = `${WEBHOOK_URL}/webhook/refresh`;
  console.log(`[script] Posting captured session -> ${endpoint}`);
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...sessionData, userId }),
  });
  console.log(`[script] refresh webhook response: ${res.status}`);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Backend returned ${res.status}: ${text}`);
  }
}

function copyProfileToLocal(persistentDir, localDir) {
  if (fs.existsSync(persistentDir)) {
    console.log(`[script] Copying profile from ${persistentDir} -> ${localDir}`);
    fs.cpSync(persistentDir, localDir, { recursive: true });
  } else {
    console.log(`[script] No existing profile found, creating fresh local profile.`);
    fs.mkdirSync(localDir, { recursive: true });
  }
}

function copyProfileBack(localDir, persistentDir) {
  console.log(`[script] Persisting profile from ${localDir} -> ${persistentDir}`);
  fs.mkdirSync(persistentDir, { recursive: true });
  fs.cpSync(localDir, persistentDir, { recursive: true });
}

async function main() {
  const globalTimeout = setTimeout(() => {
    console.error(`[script] FATAL: Global timeout reached (${TOTAL_SCRIPT_TIMEOUT_MS / 1000}s). Exiting.`);
    process.exit(1);
  }, TOTAL_SCRIPT_TIMEOUT_MS);

  const { userId, containerHost } = await getSyncContext();
  const persistentDir = `/data/browser-profiles/${userId}`;
  const localDir = `/tmp/browser-profile-${userId}`;

  copyProfileToLocal(persistentDir, localDir);

  console.log("[script] Launching browser with persistent context...");
  console.log(`[script] Profile directory: ${localDir} (userId: ${userId})`);
  console.log(`[script] Global timeout: ${TOTAL_SCRIPT_TIMEOUT_MS / 1000}s`);

  const probe = await chromium.launch({
    headless: true,
    args: ["--no-sandbox"],
  });
  const probeUA = await probe.newPage().then(async (p) => {
    const ua = await p.evaluate(() => navigator.userAgent);
    await p.close();
    return ua;
  });
  await probe.close();

  const chromeVersion = probeUA.match(/Chrome\/([\d.]+)/)?.[1] ?? "130.0.0.0";
  const userAgent = `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;
  console.log(`[script] Using user-agent: ${userAgent}`);

  const context = await chromium.launchPersistentContext(localDir, {
    headless: false,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
    ],
    userAgent,
    viewport: { width: 1920, height: 1080 },
    locale: "en-US",
    timezoneId: "America/New_York",
    ignoreHTTPSErrors: true,
  });

  const page = context.pages()[0] || (await context.newPage());

  let exitCode = 0;
  try {
    console.log("[script] Navigating to Facebook Marketplace...");
    await page.goto("https://www.facebook.com/marketplace/", {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });

    await page.waitForTimeout(5000);

    const loggedIn = await isLoggedIn(page);

    if (!loggedIn) {
      const host = containerHost || await getPublicIp();
      const novncUrl = `https://${host}`;
      await notifyNeedsLogin(novncUrl, userId);

      await waitForLogin(page);

      // After login, give the page time to settle and set cookies
      console.log("[script] Login detected, waiting for session to stabilize...");
      await page.waitForTimeout(5000);
    } else {
      console.log("[script] Already logged in, proceeding to capture.");
    }

    // Navigate to marketplace and set up capture before it loads
    console.log("[script] Setting up request interceptor for session capture...");
    const sessionPromise = captureSession(page, context);

    console.log("[script] Navigating to Marketplace for capture...");
    await page.goto("https://www.facebook.com/marketplace/", {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await page.waitForTimeout(3000);

    // Actively trigger GraphQL requests by interacting with page elements
    await triggerMarketplaceGraphQL(page);

    const sessionData = await sessionPromise;
    console.log("[script] Session captured successfully.");

    await postSession(sessionData, userId);
    console.log("[script] Done! Container exiting cleanly.");
  } catch (err) {
    console.error(`[script] ERROR: ${err.message}`);
    exitCode = 1;
  } finally {
    clearTimeout(globalTimeout);
    await context.close();
    copyProfileBack(localDir, persistentDir);
  }
  process.exit(exitCode);
}

main();
