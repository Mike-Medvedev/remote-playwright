import { chromium } from "playwright";
import fs from "fs";

const WEBHOOK_URL = process.env.WEBHOOK_URL ?? "";
const NOVNC_PORT = process.env.NOVNC_PORT ?? "6080";
const PERSISTENT_PROFILE_DIR = "/data/browser-profile";
const LOCAL_PROFILE_DIR = "/tmp/browser-profile";
const LOGIN_POLL_INTERVAL_MS = 3000;
const SESSION_CAPTURE_TIMEOUT_MS = 300_000;

if (!WEBHOOK_URL) {
  console.error("ERROR: WEBHOOK_URL environment variable is required.");
  process.exit(1);
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
  if (url.includes("/login") || url.includes("/checkpoint")) return false;

  const loginForm = await page
    .locator('form[action*="/login"], #login_form, input[name="email"]')
    .first()
    .isVisible()
    .catch(() => false);
  if (loginForm) return false;

  const hasMarketplaceContent = await page
    .locator(
      '[aria-label="Marketplace"], [data-pagelet="Marketplace"], a[href*="/marketplace"]',
    )
    .first()
    .isVisible({ timeout: 5000 })
    .catch(() => false);

  return hasMarketplaceContent;
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

async function notifyNeedsLogin(novncUrl) {
  const endpoint = `${WEBHOOK_URL}/webhook/needs-login`;
  console.log(
    `[script] Notifying backend: human login required -> ${endpoint}`,
  );
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ novncUrl }),
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

    const handler = async (request) => {
      const body = request.postData() ?? "";
      if (!isAuthenticatedGraphQL(request, body)) return;

      const reqHeaders = request.headers();
      const friendlyName = reqHeaders["x-fb-friendly-name"] || "unknown";

      // Resolve cookie: use request header if present, otherwise pull from
      // the browser context (persistent profile stores them even when the
      // browser doesn't attach them to every request)
      let cookieHeader = reqHeaders["cookie"] ?? "";
      if (!cookieHeader) {
        const cookies = await context.cookies("https://www.facebook.com");
        cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
      }

      if (!cookieHeader) {
        console.log(
          `[script] GraphQL request has no cookie anywhere, skipping: ${friendlyName}`,
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

async function postSession(sessionData) {
  const endpoint = `${WEBHOOK_URL}/webhook/refresh`;
  console.log(`[script] Posting captured session -> ${endpoint}`);
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(sessionData),
  });
  console.log(`[script] refresh webhook response: ${res.status}`);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Backend returned ${res.status}: ${text}`);
  }
}

function copyProfileToLocal() {
  if (fs.existsSync(PERSISTENT_PROFILE_DIR)) {
    console.log(`[script] Copying profile from ${PERSISTENT_PROFILE_DIR} -> ${LOCAL_PROFILE_DIR}`);
    fs.cpSync(PERSISTENT_PROFILE_DIR, LOCAL_PROFILE_DIR, { recursive: true });
  } else {
    console.log(`[script] No existing profile found, creating fresh local profile.`);
    fs.mkdirSync(LOCAL_PROFILE_DIR, { recursive: true });
  }
}

function copyProfileBack() {
  console.log(`[script] Persisting profile from ${LOCAL_PROFILE_DIR} -> ${PERSISTENT_PROFILE_DIR}`);
  fs.mkdirSync(PERSISTENT_PROFILE_DIR, { recursive: true });
  fs.cpSync(LOCAL_PROFILE_DIR, PERSISTENT_PROFILE_DIR, { recursive: true });
}

async function main() {
  copyProfileToLocal();

  console.log("[script] Launching browser with persistent context...");
  console.log(`[script] Profile directory: ${LOCAL_PROFILE_DIR}`);

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

  const context = await chromium.launchPersistentContext(LOCAL_PROFILE_DIR, {
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

  try {
    // Step 1: Navigate to marketplace
    console.log("[script] Navigating to Facebook Marketplace...");
    await page.goto("https://www.facebook.com/marketplace/", {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });

    // Give the page a moment to settle (redirects, JS hydration)
    await page.waitForTimeout(5000);

    // Step 2: Check login state
    const loggedIn = await isLoggedIn(page);

    if (!loggedIn) {
      // Step 3: Signal backend that human login is needed
      const publicIp = await getPublicIp();
      const novncUrl = `http://${publicIp}:${NOVNC_PORT}`;
      await notifyNeedsLogin(novncUrl);

      // Wait for human to log in via noVNC
      await waitForLogin(page);

      // After login, navigate to marketplace
      console.log("[script] Navigating to Marketplace after login...");
      await page.goto("https://www.facebook.com/marketplace/", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      await page.waitForTimeout(3000);
    } else {
      console.log("[script] Already logged in, proceeding to capture.");
    }

    // Step 4: Capture authenticated session
    console.log(
      "[script] Setting up request interceptor for session capture...",
    );
    const sessionPromise = captureSession(page, context);

    // Trigger marketplace activity to generate a GraphQL request
    console.log("[script] Triggering marketplace activity...");
    await page.goto("https://www.facebook.com/marketplace/", {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });

    const sessionData = await sessionPromise;
    console.log("[script] Session captured successfully.");

    // Step 5: POST session to backend
    await postSession(sessionData);
    console.log("[script] Done! Container exiting cleanly.");
  } catch (err) {
    console.error(`[script] ERROR: ${err.message}`);
    process.exit(1);
  } finally {
    await context.close();
    copyProfileBack();
  }
}

main();
