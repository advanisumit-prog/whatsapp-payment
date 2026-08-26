require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-3.5-flash-lite" });

const MONTHS = {
    jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
    jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12
};

/** Picks the mime type from the file extension — the downloader now writes .jpg. */
function mimeForPath(filePath) {
    switch (path.extname(filePath).toLowerCase()) {
        case ".png":  return "image/png";
        case ".webp": return "image/webp";
        case ".gif":  return "image/gif";
        default:      return "image/jpeg";
    }
}

/**
 * "₹1,00,000.00" / "16,000" / "8800.00" -> "100000.00" / "16000" / "8800.00"
 * Strips currency symbols and ALL comma grouping (Indian lakh grouping included),
 * so the column can be summed with CAST(amount AS REAL).
 */
function normalizeAmount(value) {
    if (value === null || value === undefined) return null;

    const cleaned = String(value)
        .replace(/[₹$€£,\s]/g, "")
        .replace(/(?:rs\.?|inr)/gi, "")
        .trim();

    if (!cleaned) return null;

    const match = cleaned.match(/-?\d+(?:\.\d+)?/);
    if (!match) return null;

    const num = Number(match[0]);
    return isNaN(num) ? null : String(num);
}

/**
 * "3 Aug 2026" / "3rd Aug 26" / "03 August 2026" / "02/08/2026" / "2026-08-03"
 * all become "2026-08-03". Returns null if it cannot be read confidently.
 */
function normalizeDate(value) {
    if (!value) return null;

    const text = String(value).trim();
    if (!text) return null;

    const iso = d => {
        const pad = v => String(v).padStart(2, "0");
        return `${d.y}-${pad(d.m)}-${pad(d.d)}`;
    };

    const fixYear = y => (y < 100 ? 2000 + y : y);

    // 2026-08-03
    let m = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (m) return iso({ y: +m[1], m: +m[2], d: +m[3] });

    // 3 Aug 2026 / 3rd August 26
    m = text.match(/(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+)\.?\s+(\d{2,4})/);
    if (m) {
        const mon = MONTHS[m[2].slice(0, 3).toLowerCase()];
        if (mon) return iso({ y: fixYear(+m[3]), m: mon, d: +m[1] });
    }

    // Aug 3, 2026
    m = text.match(/([A-Za-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{2,4})/);
    if (m) {
        const mon = MONTHS[m[1].slice(0, 3).toLowerCase()];
        if (mon) return iso({ y: fixYear(+m[3]), m: mon, d: +m[2] });
    }

    // 02/08/2026 — day-first, matching Indian UPI apps
    m = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/);
    if (m) {
        const day = +m[1];
        const mon = +m[2];
        if (mon >= 1 && mon <= 12 && day <= 31) {
            return iso({ y: fixYear(+m[3]), m: mon, d: day });
        }
    }

    return null;
}

/** "2:55 pm" / "04:14:01 PM" / "14:56" -> "14:55" / "16:14" / "14:56" */
function normalizeTime(value) {
    if (!value) return null;

    const m = String(value).trim().match(/(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?/i);
    if (!m) return null;

    let hour = +m[1];
    const minute = +m[2];

    if (m[4]) {
        const isPm = m[4].toLowerCase() === "pm";
        if (isPm && hour < 12) hour += 12;
        if (!isPm && hour === 12) hour = 0;
    }

    if (hour > 23 || minute > 59) return null;

    return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function cleanText(value) {
    if (value === null || value === undefined) return null;
    const t = String(value).trim();
    return t && t.toLowerCase() !== "null" ? t : null;
}

/** Applies normalisation, keeping the raw strings for audit. */
function normalizeRecord(raw) {

    if (!raw || typeof raw !== "object") return { isPayment: false };

    if (!raw.isPayment) return { isPayment: false };

    return {
        isPayment: true,
        amount: normalizeAmount(raw.amount),
        amountRaw: cleanText(raw.amount),
        utr: cleanText(raw.utr) ? String(raw.utr).replace(/\s+/g, "") : null,
        date: normalizeDate(raw.date),
        dateRaw: cleanText(raw.date),
        time: normalizeTime(raw.time),
        sender: cleanText(raw.sender),
        receiver: cleanText(raw.receiver),
        bank: cleanText(raw.bank)
    };
}

function buildPrompt(count) {
    return `
You will be given ${count} images, numbered in the order they appear (image 1 is first, image 2 is second, and so on).

For EACH image independently, decide whether it is a payment/transaction screenshot, and extract the fields below if so.

Return ONLY a valid JSON array with exactly ${count} elements. No markdown, no code fences, no commentary. Element at index 0 corresponds to image 1, index 1 to image 2, and so on — the array order MUST match the image order exactly.

Each element must have this exact shape:
{
  "isPayment": true,
  "amount": "",
  "utr": "",
  "date": "",
  "time": "",
  "sender": "",
  "receiver": "",
  "bank": ""
}

Extraction rules:
- "amount": digits only, no currency symbol and no thousands separators. "₹1,00,000" becomes "100000". Keep decimals if shown.
- "utr": the UTR / UPI transaction ID / reference number, digits and letters only, no spaces or labels. If several IDs appear, prefer the one labelled UTR, then UPI transaction ID, then transaction ID.
- "date": the transaction date exactly as printed in the image.
- "time": the transaction time exactly as printed, including am/pm if shown.
- "receiver": the COMPLETE payee name as printed. Do not drop leading words — "JAI ENTERPRISES" must not be returned as "ENTERPRISES".
- "sender": the COMPLETE payer name as printed, same rule.
- "bank": the bank or payment app named in the screenshot.
- If a field is not visible, use an empty string. Never invent a value.
- If an image is not a payment screenshot, return {"isPayment": false} for that element.
- If part of an image appears cut off, still extract what is fully legible and leave the rest empty.
`;
}

async function callGemini(imagePaths) {

    const imageParts = imagePaths.map(imagePath => ({
        inlineData: {
            mimeType: mimeForPath(imagePath),
            data: fs.readFileSync(imagePath, { encoding: "base64" })
        }
    }));

    const result = await model.generateContent({
        contents: [{
            role: "user",
            parts: [{ text: buildPrompt(imagePaths.length) }, ...imageParts]
        }],
        generationConfig: {
            // Forces well-formed JSON instead of relying on stripping code fences.
            responseMimeType: "application/json",
            temperature: 0
        }
    });

    const responseText = result.response.text();
    const cleaned = responseText.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(cleaned);

    if (!Array.isArray(parsed) || parsed.length !== imagePaths.length) {
        throw new Error(`Expected array of ${imagePaths.length}, got ${Array.isArray(parsed) ? parsed.length : typeof parsed}`);
    }

    return parsed;
}

async function readPaymentsBatch(imagePaths) {

    if (!imagePaths || imagePaths.length === 0) return [];

    for (let attempt = 1; attempt <= 2; attempt++) {
        try {
            const parsed = await callGemini(imagePaths);
            return parsed.map(normalizeRecord);

        } catch (err) {
            console.log(`  ⚠️ Gemini batch attempt ${attempt} failed: ${err.message}`);

            if (attempt < 2) {
                await new Promise(r => setTimeout(r, 3000));
            }
        }
    }

    // Both attempts failed. Returning isPayment:false means these images get
    // discarded — worth watching for in the logs rather than treating as normal.
    console.log(`  ❌ Giving up on this batch of ${imagePaths.length} image(s) — treating as non-payments.`);
    return imagePaths.map(() => ({ isPayment: false }));
}

module.exports = readPaymentsBatch;
