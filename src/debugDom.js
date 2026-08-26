// debugDom.js — run with:  node debugDom.js
// Opens WhatsApp, waits for you to click into the chat you care about,
// then reports which selectors actually exist and dumps one image row.

const fs = require("fs");
const { startBrowser } = require("./src/Browser");

(async () => {

    const { context, page } = await startBrowser();

    console.log("\n👉 Click into the 'Hr moby' chat and scroll to the payment image.");
    console.log("   You have 45 seconds...\n");
    await page.waitForTimeout(45000);

    const stats = await page.evaluate(() => {

        const count = sel => {
            try { return document.querySelectorAll(sel).length; }
            catch (e) { return `ERR: ${e.message}`; }
        };

        const imgs = Array.from(document.querySelectorAll("#main img, [data-testid='conversation-panel-messages'] img"));

        return {
            // containers
            conversationPanel: count('[data-testid="conversation-panel-messages"]'),
            mainPanel:         count('#main'),
            rows:              count('div[role="row"]'),

            // message-level
            msgContainer:      count('[data-testid="msg-container"]'),
            imageAlbum:        count('[data-testid="image-album"]'),
            mediaUrlProvider:  count('[data-testid="media-url-provider"]'),
            quotedMessage:     count('[data-testid="quoted-message"]'),
            msgMeta:           count('[data-testid="msg-meta"]'),
            selectableText:    count('[data-testid="selectable-text"]'),
            prePlainText:      count("[data-pre-plain-text]"),
            dataId:            count("[data-id]"),
            copyableText:      count(".copyable-text"),

            // images actually on screen
            totalImgTags:      imgs.length,
            blobImgs:          imgs.filter(i => (i.src || "").startsWith("blob:")).length,
            httpImgs:          imgs.filter(i => (i.src || "").startsWith("http")).length,
            sampleSrcs:        imgs.slice(0, 5).map(i => (i.src || "").slice(0, 70))
        };
    });

    console.log("=== SELECTOR COUNTS ===");
    console.log(JSON.stringify(stats, null, 2));

    // Dump the DOM of the row containing the first blob image — that is the
    // structure every selector in Sidebar.js needs to match against.
    const rowHtml = await page.evaluate(() => {

        const imgs = Array.from(document.querySelectorAll("#main img"));
        const img = imgs.find(i => (i.src || "").startsWith("blob:")) || imgs[0];
        if (!img) return null;

        const row = img.closest('div[role="row"]') || img.closest("[data-id]") || img.parentElement;
        if (!row) return null;

        return {
            dataId: row.getAttribute("data-id"),
            role: row.getAttribute("role"),
            html: row.outerHTML.slice(0, 20000)
        };
    });

    if (rowHtml) {
        fs.writeFileSync("debug_image_row.html", rowHtml.html);
        console.log(`\n=== IMAGE ROW ===\ndata-id: ${rowHtml.dataId}\nrole: ${rowHtml.role}`);
        console.log("Full HTML written to debug_image_row.html");
    } else {
        console.log("\n⚠️ No image found on screen — scroll the payment image into view and re-run.");
    }

    // Dump a date divider too, so the divider walk can be verified.
    const dividerHtml = await page.evaluate(() => {
        const spans = Array.from(document.querySelectorAll('#main span[dir="auto"]'));
        const hit = spans.find(s => /^(today|yesterday|monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/i.test((s.innerText || "").trim()));
        if (!hit) return null;
        const wrapper = hit.closest("div[role='row']") || hit.parentElement.parentElement;
        return { text: hit.innerText, role: wrapper.getAttribute("role"), html: wrapper.outerHTML.slice(0, 4000) };
    });

    if (dividerHtml) {
        fs.writeFileSync("debug_divider.html", dividerHtml.html);
        console.log(`\n=== DIVIDER ===\ntext: "${dividerHtml.text}"  role: ${dividerHtml.role}`);
        console.log("Written to debug_divider.html");
    } else {
        console.log("\n⚠️ No date divider visible on screen.");
    }

    await context.close();

})();
