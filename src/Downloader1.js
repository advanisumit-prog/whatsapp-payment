const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

/** Strips characters that are illegal in Windows/macOS paths; keeps spaces. */
function sanitizePathSegment(value) {
    return String(value)
        .replace(/[/\\:*?"<>|]+/g, "_")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 120) || "unnamed";
}

function extensionForMime(mime) {
    if (!mime) return ".jpg";
    if (mime.includes("png")) return ".png";
    if (mime.includes("webp")) return ".webp";
    if (mime.includes("gif")) return ".gif";
    return ".jpg";
}

class Downloader {

    constructor(page) {
        this.page = page;
    }

    /**
     * Pulls the ORIGINAL bytes behind the viewer's <img src>. WhatsApp serves
     * decrypted media as a same-origin blob: URL, so an in-page fetch returns
     * the real file rather than a re-encoded screen capture.
     * Returns { base64, type, size } or null if the fetch is not permitted.
     */
    async fetchOriginalBytes(src) {

        if (!src) return null;

        return await this.page.evaluate(async (url) => {

            try {
                const res = await fetch(url);
                if (!res.ok) return null;

                const blob = await res.blob();
                if (!blob.size) return null;

                const buffer = await blob.arrayBuffer();
                const bytes = new Uint8Array(buffer);

                // Chunked to avoid blowing the argument limit on String.fromCharCode
                let binary = "";
                const CHUNK = 0x8000;
                for (let i = 0; i < bytes.length; i += CHUNK) {
                    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
                }

                return { base64: btoa(binary), type: blob.type, size: blob.size };

            } catch (err) {
                return null;
            }

        }, src).catch(() => null);
    }

    /** Escape, then the close button, then a last check — the viewer must not stay open. */
    async closeViewer(viewerImage) {

        await this.page.keyboard.press("Escape").catch(() => {});

        let closed = await viewerImage.waitFor({ state: "hidden", timeout: 5000 })
            .then(() => true)
            .catch(() => false);

        if (!closed) {
            const closeButton = this.page
                .locator('[data-testid="btn-closer"], [aria-label="Close"], [data-icon="x"], [data-icon="x-viewer"]')
                .first();

            await closeButton.click({ timeout: 3000 }).catch(() => {});

            closed = await viewerImage.waitFor({ state: "hidden", timeout: 5000 })
                .then(() => true)
                .catch(() => false);
        }

        if (!closed) {
            // A stuck overlay swallows the next image's click, so this is worth shouting about.
            console.log("  ⚠️ Media viewer did not close — the next download may fail.");
        }

        await this.page.waitForTimeout(500);
        return closed;
    }

    /**
     * Scrolls the conversation panel itself, so WhatsApp renders the rows
     * between here and the message we want.
     *
     * Messages are downloaded oldest-to-newest, so the next unrendered row is
     * almost always further down — scroll a little at a time rather than
     * jumping, to avoid overshooting into a later part of the chat.
     */
    async nudgeTowardMessage() {

        const container = this.page.locator('[data-testid="conversation-panel-messages"]');
        const box = await container.boundingBox().catch(() => null);

        if (!box) return;

        await this.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);

        for (let w = 0; w < 3; w++) {
            await this.page.mouse.wheel(0, 500);
            await this.page.waitForTimeout(250);
        }
    }

    async download(groupName, image, index, previousSrc = null, messageId = null, mediaIndex = 0) {

        const folder = path.join("downloads", sanitizePathSegment(groupName));
        fs.mkdirSync(folder, { recursive: true });

        console.log(`Downloading image ${index + 1} (album item ${mediaIndex + 1})`);

        // Best effort only — the retry block below handles a row that is not
        // mounted, so a failure here is not worth reporting.
        await image.locator.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
        await this.page.waitForTimeout(300);

        // Get all media elements in this message, then exclude any that are
        // nested inside a quoted-message preview — those aren't real
        // standalone images, just references to an earlier message.
        // This must match the same exclusion logic used when counting
        // mediaCount in Sidebar.js, so indices line up correctly.
        let providers = await image.locator.locator('[data-testid="media-url-provider"]').all();
        let thumbs = await image.locator.locator('[data-testid="image-thumb"]').all();

        // The row may have been virtualized out of the DOM between collection
        // and download — the message is real, it just is not rendered right now.
        // Scroll it back and re-query rather than abandoning the payment.
        if (providers.length === 0 && thumbs.length === 0) {

            // scrollIntoViewIfNeeded only acts on an element already in the DOM.
            // WhatsApp virtualizes the message list, so a row far from the
            // current scroll position is not there to find — re-waiting on the
            // same locator will never mount it. Nudge the panel's own scroll
            // position instead, which makes WhatsApp render the rows in between.
            for (let retry = 1; retry <= 5; retry++) {

                const attached = await image.locator
                    .scrollIntoViewIfNeeded({ timeout: 3000 })
                    .then(() => true)
                    .catch(() => false);

                if (!attached) {
                    await this.nudgeTowardMessage();
                }

                await this.page.waitForTimeout(600 + 300 * retry);

                providers = await image.locator.locator('[data-testid="media-url-provider"]').all();
                thumbs = await image.locator.locator('[data-testid="image-thumb"]').all();

                if (providers.length > 0 || thumbs.length > 0) {
                    if (retry > 1) console.log(`  ✓ Found it after ${retry} nudge(s).`);
                    break;
                }

                if (retry === 1) {
                    console.log("  🔄 Not rendered — nudging the conversation to bring it back...");
                }
            }

            if (providers.length === 0 && thumbs.length === 0) {
                console.log("  ⏭ Still not rendered — skipping (it will be retried next run).");
                return null;
            }
        }

        // Whichever list is longer covers every item: an album photo not yet
        // fetched has an image-thumb but no media-url-provider.
        const allMediaLocators = thumbs.length > providers.length ? thumbs : providers;

        const realMedia = [];

        for (const el of allMediaLocators) {
            const isQuoted = await el.locator('xpath=ancestor::*[@data-testid="quoted-message"]').count();
            if (isQuoted === 0) {
                realMedia.push(el);
            }
        }

        console.log(`  Real media in this message: ${realMedia.length} (requesting index ${mediaIndex})`);

        if (realMedia.length === 0) {
            console.log("No media element found in this message.");
            return null;
        }

        // Albums do not map tiles to photos one-for-one: WhatsApp shows a few
        // tiles and stacks the rest behind a "+N" overlay on the last one. So
        // tile index != photo index, and clicking tiles skips photos.
        //
        // Always open the FIRST tile and page forward instead — the viewer walks
        // every photo in order regardless of how they were tiled.
        const isAlbum = String(messageId || "").startsWith("album-");

        let clickIndex = mediaIndex;
        let advanceBy = 0;

        if (isAlbum) {
            clickIndex = 0;
            advanceBy = mediaIndex;
            if (mediaIndex > 0) {
                console.log(`  ↪️ Album photo ${mediaIndex + 1}: opening the first photo and advancing ${advanceBy} in the viewer.`);
            }
        } else if (mediaIndex >= realMedia.length) {
            clickIndex = realMedia.length - 1;
            advanceBy = mediaIndex - clickIndex;
            console.log(`  ↪️ Photo ${mediaIndex + 1} has no tile — opening tile ${clickIndex + 1} and advancing ${advanceBy} in the viewer.`);
        }

        const media = realMedia[clickIndex];

        const viewerImage = this.page
            .locator('[data-testid="media-image"] img')
            .first();

        // Open the viewer, with one retry — a mistimed click leaves nothing to wait for.
        let viewerOpen = false;

        for (let attempt = 1; attempt <= 2 && !viewerOpen; attempt++) {
            try {
                await media.click({ timeout: 10000 });
                console.log(`  Clicked media (attempt ${attempt}). Waiting for viewer...`);
                await viewerImage.waitFor({ state: "visible", timeout: 15000 });
                viewerOpen = true;
            } catch (err) {
                console.log(`  ⚠️ Viewer did not open on attempt ${attempt}: ${err.message}`);
                await this.page.keyboard.press("Escape").catch(() => {});
                await this.page.waitForTimeout(1000);
            }
        }

        if (!viewerOpen) {
            console.log("  ❌ Could not open the media viewer — skipping this item.");
            return null;
        }

        // Page forward to the photo that had no tile of its own.
        for (let step = 0; step < advanceBy; step++) {

            const before = await viewerImage.getAttribute("src").catch(() => null);

            const nextButton = this.page
                .locator('[aria-label="Next"], [data-icon="forward-refreshed"], [data-testid="next-slide"]')
                .first();

            const clicked = await nextButton.click({ timeout: 3000 }).then(() => true).catch(() => false);

            if (!clicked) {
                await this.page.keyboard.press("ArrowRight").catch(() => {});
            }

            // The next photo may not be fetched yet, so wait for src to change
            // rather than assuming a fixed delay is enough. Capturing early gives
            // the SAME image twice, which looks like a duplicate payment.
            let changed = false;

            for (let wait = 0; wait < 30; wait++) {
                await this.page.waitForTimeout(500);
                const now = await viewerImage.getAttribute("src").catch(() => null);
                if (now && now !== before) { changed = true; break; }
            }

            if (!changed) {
                console.log(`  ⚠️ Viewer did not advance on step ${step + 1} — the capture may repeat the previous photo.`);
            }
        }

        let src = await viewerImage.getAttribute("src");
        const maxRetries = 10;
        let retries = 0;

        while (previousSrc && src === previousSrc && retries < maxRetries) {
            console.log(`  ⏳ Same src as previous image, waiting... (${retries + 1}/${maxRetries})`);
            await this.page.waitForTimeout(500);
            src = await viewerImage.getAttribute("src");
            retries++;
        }

        if (previousSrc && src === previousSrc) {
            console.log("  ⚠️ WARNING: Image src never changed — likely a duplicate!");
        }

        const safeMessageId = sanitizePathSegment(messageId || `msg_${Date.now()}`);

        // Preferred path: the original file, at full resolution.
        const original = await this.fetchOriginalBytes(src);

        let fileName;
        let filePath;

        if (original && original.base64) {

            fileName = `${safeMessageId}_${mediaIndex}${extensionForMime(original.type)}`;
            filePath = path.join(folder, fileName);

            fs.writeFileSync(filePath, Buffer.from(original.base64, "base64"));
            console.log(`Saved original (${Math.round(original.size / 1024)} KB, ${original.type}): ${filePath}`);

        } else {

            // Fallback: screen capture. Lower fidelity — OCR accuracy on small
            // digits (UTR, amount) drops, so this path is worth knowing about.
            fileName = `${safeMessageId}_${mediaIndex}.png`;
            filePath = path.join(folder, fileName);

            await viewerImage.screenshot({ path: filePath });
            console.log(`⚠️ Saved via SCREENSHOT fallback (reduced quality): ${filePath}`);
        }

        // Content hash of the bytes we actually stored — now stable across groups,
        // because it no longer depends on how the image happened to render.
        const fileBuffer = fs.readFileSync(filePath);
        const hash = crypto.createHash("sha256").update(fileBuffer).digest("hex");

        await this.closeViewer(viewerImage);

        return { groupName, fileName, filePath, src, hash };
    }
}

module.exports = Downloader;
