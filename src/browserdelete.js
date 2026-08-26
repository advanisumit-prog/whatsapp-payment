// src/browser.js

const { chromium } = require("playwright");
const settings = require("./config/settings");
console.log(">>> LOADED:", __filename);

// page.goto() defaults to 30s regardless of any waitForSelector timeout that
// follows it — on a cold morning the navigation itself is what times out.
const NAV_TIMEOUT     = settings.navTimeout     || 180000;  // 3 min
const DEFAULT_TIMEOUT = settings.defaultTimeout || 60000;   // baseline for all locators

// Tracked so the cleanup handlers below can close it from anywhere.
let activeContext = null;
let cleanupRegistered = false;
let closing = false;

/**
 * Closes the browser. Safe to call more than once — App.js can call it in a
 * finally block while a signal handler races to do the same.
 */
async function closeBrowser() {

    if (!activeContext || closing) return;

    closing = true;

    try {
        await activeContext.close();
        console.log("🧹 Browser closed.");
    } catch (err) {
        console.log(`⚠️ Error closing browser: ${err.message}`);
    } finally {
        activeContext = null;
        closing = false;
    }
}

/**
 * Safety net: a stranded Chromium keeps a lock on ./session, so the NEXT run
 * fails to launch. These handlers make sure that cannot happen even if the
 * caller forgets, crashes, or is killed with Ctrl+C.
 */
function registerCleanup() {

    if (cleanupRegistered) return;
    cleanupRegistered = true;

    const bail = async (label, code) => {
        console.log(`\n🛑 ${label} — closing browser...`);
        await closeBrowser();
        process.exit(code);
    };

    process.once("SIGINT",  () => bail("Interrupted (Ctrl+C)", 130));
    process.once("SIGTERM", () => bail("Terminated", 143));

    process.once("uncaughtException", async err => {
        console.error("💥 Uncaught exception:", err);
        await bail("Crashed", 1);
    });

    process.once("unhandledRejection", async err => {
        console.error("💥 Unhandled rejection:", err);
        await bail("Crashed", 1);
    });
}

async function startBrowser() {

    const context = await chromium.launchPersistentContext("./session", {
        headless: false,
        viewport: null,
        args: [
            "--start-maximized",
            // 64MB /dev/shm stalls a heavy page under load; harmless on desktop.
            "--disable-dev-shm-usage"
        ]
    });

    activeContext = context;
    registerCleanup();

    // Applies to every page/locator in this context, so individual calls only
    // need an override when they want something longer.
    context.setDefaultTimeout(DEFAULT_TIMEOUT);
    context.setDefaultNavigationTimeout(NAV_TIMEOUT);

    const page = context.pages()[0] || await context.newPage();

    console.log("🌐 Opening WhatsApp Web...");

    // "domcontentloaded" instead of the default "load": WhatsApp keeps fetching
    // long after the app is usable, so waiting for "load" adds minutes for nothing.
    await page.goto("https://web.whatsapp.com", {
        waitUntil: "domcontentloaded",
        timeout: NAV_TIMEOUT
    });

    // Shell only. This deliberately also matches the QR screen so an expired
    // session surfaces immediately instead of hanging until the timeout —
    // sidebar.waitUntilReady() identifies and reports which one it is.
    await page.waitForSelector(
        '#pane-side, [data-testid^="list-item-"], canvas[aria-label*="Scan"], [data-testid="qrcode"], [data-testid="qrcode-container"]',
        { timeout: NAV_TIMEOUT }
    );

    console.log("🌐 App shell loaded — checking sync state next.");

    return { context, page };
}

module.exports = { startBrowser, closeBrowser };
