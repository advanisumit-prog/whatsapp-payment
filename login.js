// login.js  (project root)
//
//   node login.js
//
// Standalone: uses Playwright directly rather than src/Browser.js, so none of
// the cleanup handlers there can close the window while you are scanning.
// Stays open until you press Enter in this terminal.

const { chromium } = require("playwright");
const readline = require("readline");

(async () => {

    console.log("Launching browser...");

    const context = await chromium.launchPersistentContext("./session", {
        headless: false,
        viewport: null,
        args: [
            "--start-maximized",
            "--disable-dev-shm-usage",
            "--disable-background-timer-throttling",
            "--disable-backgrounding-occluded-windows",
            "--disable-renderer-backgrounding",
            "--disable-features=CalculateNativeWinOcclusion"
        ]
    });

    const page = context.pages()[0] || await context.newPage();

    await page.goto("https://web.whatsapp.com", {
        waitUntil: "domcontentloaded",
        timeout: 180000
    });

    console.log("\n=================================================");
    console.log("  Scan the QR code with your phone:");
    console.log("  WhatsApp -> Settings -> Linked devices -> Link a device");
    console.log("");
    console.log("  The window stays open until you press Enter here.");
    console.log("  Wait until your chats have finished loading first.");
    console.log("=================================================\n");

    // Report progress every 10s so you can see whether it linked, without
    // anything closing the browser on a timeout.
    const timer = setInterval(async () => {
        const chats = await page
            .locator('[data-testid^="list-item-"]')
            .count()
            .catch(() => 0);

        const qr = await page
            .locator('canvas[aria-label*="Scan"], [data-testid="qrcode"]')
            .first()
            .isVisible()
            .catch(() => false);

        if (chats > 0) {
            console.log(`  ✅ Linked — ${chats} chat(s) loaded. Press Enter when the list looks complete.`);
        } else if (qr) {
            console.log("  … waiting for you to scan the QR code");
        } else {
            console.log("  … loading");
        }
    }, 10000);

    await new Promise(resolve => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.question("", () => { rl.close(); resolve(); });
    });

    clearInterval(timer);

    const finalChats = await page
        .locator('[data-testid^="list-item-"]')
        .count()
        .catch(() => 0);

    console.log(`\nClosing. ${finalChats} chat(s) were visible.`);
    console.log(finalChats > 0
        ? "Session saved to .\\session — you can now run: node app.js"
        : "No chats seen — the link may not have completed. Re-run login.js.");

    await context.close().catch(() => {});
    process.exit(0);

})();
