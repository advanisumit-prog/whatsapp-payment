require("dotenv").config();
const fs = require("fs");
const launchBrowser = require("../src/Browser");

(async () => {

    const { page } = await launchBrowser();

    await page.goto(process.env.WHATSAPP_URL);

    await page.waitForTimeout(5000);

    const rows = page.locator('[role="row"]');

    const count = await rows.count();

    console.log(`Rows Found: ${count}`);

    for (let i = 0; i < count; i++) {

        const row = rows.nth(i);

        const html = await row.evaluate(el => el.outerHTML);

        if (
            html.toLowerCase().includes("unread") ||
            html.toLowerCase().includes("aria-label")
        ) {

            fs.writeFileSync("unread.html", html);

            console.log("Unread row saved as unread.html");

            break;
        }
    }

})();