async function main() {
  const browser = await chromium.launch({
    headless: false,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    // Start capturing BEFORE login so we don't miss anything
    const sessionPromise = new Promise((resolve) => {
      const handler = (request) => {
        if (!isUsableRequest(request)) return;
        console.log(
          "[script] Captured valid GraphQL request with cookie + body.",
        );
        page.off("request", handler);
        resolve({
          headers: request.headers(),
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
    }

    console.log(
      "[script] Waiting for login to complete (handle any CAPTCHA via noVNC)...",
    );
    await page.waitForURL(
      (url) => /^https:\/\/www\.facebook\.com\/?$/.test(url.toString()),
      { timeout: 30 * 60 * 1_000 },
    );
    console.log("[script] Login detected! Navigating to Marketplace...");

    // Navigate to marketplace to trigger graphql requests
    page
      .goto("https://www.facebook.com/marketplace/", {
        waitUntil: "domcontentloaded",
      })
      .catch(() => {});

    // Wait up to 2 minutes for a valid request
    const sessionData = await Promise.race([
      sessionPromise,
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error("Capture timeout after 2 minutes")),
          2 * 60 * 1_000,
        ),
      ),
    ]);

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
