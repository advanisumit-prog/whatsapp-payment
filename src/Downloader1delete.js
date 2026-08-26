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

    async download(groupName, image, index, previousSrc = null, messageId = null, mediaIndex = 0) {

        const folder = path.join("downloads", sanitizePathSegment(groupName));
        fs.mkdirSync(folder, { recursive: true });

        console.log(`Downloading image ${index + 1} (album item ${mediaIndex + 1})`);

        try {
            await image.locator.scrollIntoViewIfNeeded({ timeout: 5000 });
            await this.page.waitForTimeout(300);
        } catch (err) {
            console.log(`  ⚠️ Could not scroll message into view: ${err.message}`);
        }

        // Get all media elements in this message, then exclude any that are
        // nested inside a quoted-message preview — those aren't real
        // standalone images, just references to an earlier message.
        // This must match the same exclusion logic used when counting
        // mediaCount in Sidebar.js, so indices line up correctly.
        let allMediaLocators = await image.locator.locator('[data-testid="media-url-provider"]').all();

        // An image WhatsApp has not fetched yet has no media-url-provider, only
        // an image-thumb. Clicking the thumb opens the viewer just the same, so
        // fall back to it rather than reporting no media and losing the payment.
        if (allMediaLocators.length === 0) {
            allMediaLocators = await image.locator.locator('[data-testid="image-thumb"]').all();
            if (allMediaLocators.length > 0) {
                console.log(`  ⏳ Using image-thumb (media not preloaded) — ${allMediaLocators.length} found.`);
            }
        }

        const realMedia = [];

        for (const el of allMediaLocators) {
            const isQuoted = await el.locator('xpath=ancestor::*[@data-testid="quoted-message"]').count();
            if (isQuoted === 0) {
                realMedia.push(el);
            }
        }

        console.log(`  Real media in this message: ${realMedia.length} (requesting index ${mediaIndex})`);

        if (mediaIndex >= realMedia.length) {
            console.log("No media element found at this index (after excluding quoted previews).");
            return null;
        }

        const media = realMedia[mediaIndex];

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
