require("dotenv").config();

const launchBrowser = require("../src/Browser");

(async () => {
    const { page } = await launchBrowser();

    await page.goto(process.env.WHATSAPP_URL);

    await page.waitForLoadState("domcontentloaded");

    // Pause here and open Playwright Inspector
    await page.pause();
})();