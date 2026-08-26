const watchList = require("./config/watchList");
const settings = require("./config/settings");
const fs = require("fs");
const readPayment = require("../readPayment");
const readPaymentsBatch = require("../readPaymentsBatch");
const phash = require("sharp-phash");
const phashDistance = require("sharp-phash/distance");


// ---------------------------------------------------------------------------
// Tunable waits. Override in config/settings.js if you want per-environment
// values. These are MAX waits, not fixed sleeps — the script continues as soon
// as the element appears.
// ---------------------------------------------------------------------------
const SEARCH_RESULTS_TIMEOUT = settings.searchResultsTimeout || 60000;   // after typing the keyword
const CHAT_LOAD_TIMEOUT      = settings.chatLoadTimeout      || 120000;  // after clicking the chat
const CHAT_LOAD_RETRY_TIMEOUT = 30000;                                   // second attempt if the first times out
const APP_READY_TIMEOUT      = settings.appReadyTimeout      || 900000;  // 15 min — cold morning sync
const POST_READY_SETTLE      = settings.postReadySettle      || 10000;   // breathing room after "ready"

// WhatsApp renders data-pre-plain-text using the browser locale.
// true  -> [14:32, 15/07/2026]  (DD/MM/YYYY — Indian/UK locales)
// false -> [2:32 pm, 07/15/2026] (MM/DD/YYYY — US locale)
// Verify against one real attribute value before trusting it; a wrong setting
// silently breaks the date window for days 1-12 only, which is easy to miss.
const DATE_IS_DAY_FIRST = settings.dateIsDayFirst !== undefined ? settings.dateIsDayFirst : true;

// Stop collecting as soon as today's messages are reached. Saves scrolling on
// a long chat, but a single mis-dated message cuts the run short and the tail
// is lost silently — so it is OFF unless explicitly enabled.
const STOP_AT_TODAY = settings.stopAtToday === true;


function parseDividerDate(text) {
    const trimmed = text.trim();
    const today = new Date();

    if (/^today$/i.test(trimmed)) {
        return new Date(today.getFullYear(), today.getMonth(), today.getDate());
    }
    if (/^yesterday$/i.test(trimmed)) {
        const y = new Date(today);
        y.setDate(y.getDate() - 1);
        return new Date(y.getFullYear(), y.getMonth(), y.getDate());
    }

    const weekdays = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
    const weekdayIndex = weekdays.indexOf(trimmed.toLowerCase());
    if (weekdayIndex !== -1) {
        const todayIndex = today.getDay();
        let daysAgo = todayIndex - weekdayIndex;
        if (daysAgo <= 0) daysAgo += 7;
        const d = new Date(today);
        d.setDate(d.getDate() - daysAgo);
        return new Date(d.getFullYear(), d.getMonth(), d.getDate());
    }

    const longMatch = trimmed.match(/(\d{1,2})\s+(\w+)\s+(\d{4})/);
    if (longMatch) {
        const [, day, monthName, year] = longMatch;
        const parsed = new Date(`${monthName} ${day}, ${year}`);
        if (!isNaN(parsed)) return new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate());
    }

    // Numeric dividers such as "23/07/2026" — day-first, as WhatsApp renders
    // them on Indian locales. Older parts of a chat use these instead of
    // "Yesterday"/weekday names, so without this the date context goes blank.
    const numericMatch = trimmed.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
    if (numericMatch) {
        const day = Number(numericMatch[1]);
        const month = Number(numericMatch[2]);
        let year = Number(numericMatch[3]);
        if (year < 100) year += 2000;

        if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
            const d = new Date(year, month - 1, day);
            if (!isNaN(d) && d.getMonth() === month - 1) return d;
        }
    }

    return null;
}

/**
 * Parses WhatsApp's data-pre-plain-text attribute, e.g.
 *   "[14:32, 15/07/2026] Ramesh: "
 *   "[2:32 pm, 07/15/2026] Ramesh: "
 * This is an exact per-message timestamp and is far more reliable than
 * inferring the date from whichever divider happens to be scrolled into view.
 * Returns { date, timeText, timestamp } or null.
 */
function parsePrePlainText(pre) {
    if (!pre) return null;

    const m = pre.match(/\[(\d{1,2}):(\d{2})(?::\d{2})?\s*(am|pm)?,\s*(\d{1,2})\/(\d{1,2})\/(\d{2,4})\]/i);
    if (!m) return null;

    const [, hhRaw, mmRaw, ampm, firstNum, secondNum, yearRaw] = m;

    let hour = parseInt(hhRaw, 10);
    const minute = parseInt(mmRaw, 10);

    if (ampm) {
        const isPm = ampm.toLowerCase() === "pm";
        if (isPm && hour < 12) hour += 12;
        if (!isPm && hour === 12) hour = 0;
    }

    const day   = parseInt(DATE_IS_DAY_FIRST ? firstNum  : secondNum, 10);
    const month = parseInt(DATE_IS_DAY_FIRST ? secondNum : firstNum,  10);

    let year = parseInt(yearRaw, 10);
    if (year < 100) year += 2000;

    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    if (hour > 23 || minute > 59) return null;

    return {
        date: new Date(year, month - 1, day),                       // date only, for window checks
        timeText: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
        timestamp: new Date(year, month - 1, day, hour, minute)     // full precision, for sorting
    };
}

const MAX_LABEL_LENGTH = settings.maxLabelLength || 60;

/**
 * A party label is a short, single-line name like "nikhil hyderabad" or
 * "Rvc ulhasnagar". This rejects everything else — most importantly the
 * Google Pay share boilerplate that arrives as an image CAPTION ("Crores of
 * Indians trust Google Pay ... https://gpay.app.goo.gl/..."), which would
 * otherwise be trusted over the real name posted underneath.
 */
function isPlausibleLabel(text) {

    if (!text) return false;

    const trimmed = text.trim();
    if (!trimmed) return false;

    if (trimmed.includes("\n")) return false;                 // names are one line
    if (/https?:\/\/|www\./i.test(trimmed)) return false;     // contains a link
    if (trimmed.length > MAX_LABEL_LENGTH) return false;

    return true;
}

/**
 * Finds the party name for an image by looking DOWN the DOM for the next
 * text-only message — which is how this group posts them:
 *   image            -> "nikhil hyderabad"
 *   image, image, image -> "anil shop"   (label covers the whole batch)
 *
 * XPath skips any intervening image rows, so a batch of 4-5 images all resolve
 * to the same following label. Doing this per-row (instead of via a queue that
 * survives between scroll passes) means a stale text message further up can
 * never be applied to the wrong image.
 */
async function readFollowingLabel(row) {

    // Same reasoning as readNearestDividerDate: an in-page walk instead of a
    // following:: axis. Steps forward past any further image rows, so a batch
    // of images all resolve to the one label posted beneath them.
    const text = await row.evaluate(el => {

        let node = el;
        let hops = 0;

        while (node && hops < 5) {

            let next = node.nextElementSibling;

            while (next) {
                const hasMedia = next.querySelector('[data-testid="media-url-provider"]');
                const textNode = next.querySelector('[data-testid="selectable-text"] > span');

                if (!hasMedia && textNode && textNode.innerText && textNode.innerText.trim()) {
                    return textNode.innerText;
                }
                next = next.nextElementSibling;
            }

            node = node.parentElement;
            hops++;

            if (node && node.getAttribute("data-testid") === "conversation-panel-messages") break;
        }

        return null;

    }).catch(() => null);

    if (!text) return null;

    if (!isPlausibleLabel(text)) {
        console.log(`  🚫 Following text rejected as label: "${text.trim().slice(0, 40).replace(/\n/g, " ")}..."`);
        return null;
    }

    return text.trim();
}

/** Reads and parses data-pre-plain-text from a message/album locator. */
async function readMessageDateTime(scope) {
    const pre = await scope
        .locator('[data-pre-plain-text]')
        .first()
        .getAttribute("data-pre-plain-text", { timeout: 1500 })
        .catch(() => null);

    return parsePrePlainText(pre);
}

/**
 * Finds the date divider immediately ABOVE a given row, in document order.
 *
 * Needed because data-pre-plain-text lives on WhatsApp's copyable-text wrapper,
 * which only exists for text messages and CAPTIONED images. An image with no
 * caption — the common case when the party name is typed as a separate message
 * underneath — has no timestamp attribute at all, so its date must come from
 * the divider. Resolving it per-row (rather than from a running variable) means
 * it does not matter where the current scroll pass began.
 *
 * On a reverse axis, [1] selects the NEAREST preceding node.
 */
/**
 * Last-resort date inference for a row with no timestamp attribute and no
 * divider above it — typically the TOPMOST row in the rendered window, whose
 * divider has been virtualized away.
 *
 * Reads the nearest message carrying data-pre-plain-text both above AND below.
 * Messages are chronological, so if both sit on the same calendar day, the row
 * between them is that day too. If they disagree the row straddles midnight,
 * and we return null rather than guess.
 */
async function readNeighbourDate(row) {

    const pair = await row.evaluate(el => {

        const grab = (start, dir) => {
            let node = start;
            let hops = 0;
            while (node && hops < 5) {
                let sib = dir === "prev" ? node.previousElementSibling : node.nextElementSibling;
                while (sib) {
                    const holder = sib.querySelector("[data-pre-plain-text]");
                    if (holder) return holder.getAttribute("data-pre-plain-text");
                    sib = dir === "prev" ? sib.previousElementSibling : sib.nextElementSibling;
                }
                node = node.parentElement;
                hops++;
                if (node && node.getAttribute("data-testid") === "conversation-panel-messages") break;
            }
            return null;
        };

        return { before: grab(el, "prev"), after: grab(el, "next") };

    }).catch(() => null);

    if (!pair) return null;

    const before = parsePrePlainText(pair.before);
    const after = parsePrePlainText(pair.after);

    // BOTH sides must agree. A single-sided guess is wrong precisely at a day
    // boundary — the first message under a "Today" divider would inherit
    // yesterday from the message above it and slip into the window.
    if (before && after && before.date.getTime() === after.date.getTime()) {
        return before.date;
    }

    return null;
}

/**
 * Reads the full timestamps of the nearest dated messages above and below.
 * Used to sanity-check a resolved date without relying on anything Gemini says.
 */
async function readNeighbourStamps(row) {

    const pair = await row.evaluate(el => {

        const grab = (start, dir) => {
            let node = start;
            let hops = 0;
            while (node && hops < 5) {
                let sib = dir === "prev" ? node.previousElementSibling : node.nextElementSibling;
                while (sib) {
                    const holder = sib.querySelector("[data-pre-plain-text]");
                    if (holder) return holder.getAttribute("data-pre-plain-text");
                    sib = dir === "prev" ? sib.previousElementSibling : sib.nextElementSibling;
                }
                node = node.parentElement;
                hops++;
                if (node && node.getAttribute("data-testid") === "conversation-panel-messages") break;
            }
            return null;
        };

        return { before: grab(el, "prev"), after: grab(el, "next") };

    }).catch(() => null);

    if (!pair) return { before: null, after: null };

    return {
        before: parsePrePlainText(pair.before),
        after: parsePrePlainText(pair.after)
    };
}

/**
 * Messages render in chronological order, so a row's timestamp must fall
 * between its neighbours'. A date resolved one day early lands BEFORE the
 * message above it — impossible, and the signature of a missed divider.
 *
 * Returns null when valid, or a reason string when not.
 */
/**
 * Walks UP from a row looking at the clock time on each message bubble, and
 * stops at the first date divider.
 *
 * Every message shows HH:MM, including uncaptioned images that carry no
 * data-pre-plain-text — so this works where the neighbour-timestamp check
 * cannot. Within a single day times only increase, so a row whose time is
 * EARLIER than the message above it, with no divider between them, has been
 * given the wrong date.
 *
 * Returns { minutes } for the preceding bubble, { divider: text } if a divider
 * came first, or null.
 */
async function findPrecedingBubbleTime(row) {

    return await row.evaluate(el => {

        const toMinutes = text => {
            const m = (text || "").match(/(\d{1,2}):(\d{2})\s*(am|pm)?/i);
            if (!m) return null;
            let h = parseInt(m[1], 10);
            const mm = parseInt(m[2], 10);
            if (m[3]) {
                const isPm = m[3].toLowerCase() === "pm";
                if (isPm && h < 12) h += 12;
                if (!isPm && h === 12) h = 0;
            }
            return h * 60 + mm;
        };

        let node = el;
        let hops = 0;

        while (node && hops < 5) {

            let prev = node.previousElementSibling;

            while (prev) {

                const hasMessage = prev.querySelector('[data-testid="msg-container"], [data-testid="image-album"]');

                if (!hasMessage) {
                    // A divider resets the day — nothing above it is comparable.
                    const t = (prev.innerText || "").trim();
                    if (t && t.length <= 30) return { divider: t };
                } else {
                    const meta = prev.querySelector('[data-testid="msg-meta"] span');
                    if (meta) {
                        const v = toMinutes(meta.innerText);
                        if (v !== null) return { minutes: v };
                    }
                }

                prev = prev.previousElementSibling;
            }

            node = node.parentElement;
            hops++;

            if (node && node.getAttribute("data-testid") === "conversation-panel-messages") break;
        }

        return null;

    }).catch(() => null);
}

/** "14:32" or "2:32 pm" -> minutes since midnight */
function timeTextToMinutes(text) {
    const m = (text || "").match(/(\d{1,2}):(\d{2})\s*(am|pm)?/i);
    if (!m) return null;
    let h = parseInt(m[1], 10);
    const mm = parseInt(m[2], 10);
    if (m[3]) {
        const isPm = m[3].toLowerCase() === "pm";
        if (isPm && h < 12) h += 12;
        if (!isPm && h === 12) h = 0;
    }
    return h * 60 + mm;
}

async function validateTimestamp(row, sortKey, timeText) {

    if (!sortKey) return null;

    const { before, after } = await readNeighbourStamps(row);

    // Allow a minute of slack: WhatsApp shows HH:MM, so two messages in the
    // same minute can legitimately compare as equal or a shade out of order.
    const SLACK_MS = 60 * 1000;

    if (before && sortKey < before.timestamp.getTime() - SLACK_MS) {
        return `earlier than the message above it (${before.timestamp.toLocaleString()})`;
    }

    if (after && sortKey > after.timestamp.getTime() + SLACK_MS) {
        return `later than the message below it (${after.timestamp.toLocaleString()})`;
    }

    // Bubble-clock check: works for uncaptioned images, which have no
    // data-pre-plain-text for the comparison above to use.
    const mine = timeTextToMinutes(timeText);

    if (mine !== null) {

        const preceding = await findPrecedingBubbleTime(row);

        if (preceding && preceding.minutes !== undefined && preceding.minutes !== null) {
            if (mine < preceding.minutes - 1) {
                return `out of order: ${timeText} sits below a message at ` +
                       `${String(Math.floor(preceding.minutes / 60)).padStart(2, "0")}:` +
                       `${String(preceding.minutes % 60).padStart(2, "0")} with no date divider between them`;
            }
        }
    }

    return null;
}

/**
 * Reads the WHOLE rendered conversation in document order and returns a map of
 * message id -> { date, timeText }.
 *
 * This replaces walking outward from each row, which kept missing dividers:
 * sibling walks depend on where the divider sits relative to the row, and
 * WhatsApp's nesting varies. Reading top to bottom and carrying the current
 * date forward is exactly how a person reads the chat, so a divider anywhere
 * above a message applies to it.
 */
async function buildDateMap(container) {

    const items = await container.evaluate(root => {

        const out = [];
        const seen = new Set();

        const walk = node => {

            for (const child of node.children) {

                const id = child.getAttribute("data-id");

                if (id) {
                    if (!seen.has(id)) {
                        seen.add(id);
                        const meta = child.querySelector('[data-testid="msg-meta"] span');
                        out.push({
                            type: "msg",
                            id,
                            time: meta ? (meta.innerText || "").trim() : null
                        });
                    }
                    continue;              // do not descend into a message
                }

                // A wrapper with no message inside and short text is a divider.
                if (!child.querySelector("[data-id]")) {
                    const t = (child.innerText || "").trim();
                    if (t && t.length <= 30) {
                        out.push({ type: "divider", text: t });
                        continue;
                    }
                }

                walk(child);
            }
        };

        walk(root);
        return out;

    }).catch(() => []);

    const map = new Map();
    let current = null;

    for (const item of items) {

        if (item.type === "divider") {
            const parsed = parseDividerDate(item.text);
            if (parsed) current = parsed;
            continue;
        }

        if (current) {
            map.set(item.id, { date: current, timeText: item.time || null });
        }
    }

    return map;
}

async function readNearestDividerDate(row) {

    // Collects the text of every non-message element above this row, nearest
    // first, and lets parseDividerDate decide which is a date.
    //
    // Detecting dividers by TEXT rather than by DOM shape matters: a structural
    // check that misses the divider makes the row inherit the previous day —
    // and the row directly under a "Today" divider is exactly where that error
    // pulls a message into a window that is supposed to exclude today.
    const texts = await row.evaluate(el => {

        const out = [];
        let node = el;
        let hops = 0;

        while (node && hops < 5) {

            let prev = node.previousElementSibling;

            while (prev) {
                // Anything containing a message is not a divider.
                if (!prev.querySelector('[data-testid="msg-container"], [data-testid="image-album"]')) {
                    const t = (prev.innerText || "").trim();
                    // Dividers are short: "Today", "Yesterday", "23/07/2026".
                    if (t && t.length <= 30) out.push(t);
                }
                prev = prev.previousElementSibling;
            }

            node = node.parentElement;
            hops++;

            if (node && node.getAttribute("data-testid") === "conversation-panel-messages") break;
        }

        return out;

    }).catch(() => null);

    if (!texts) return null;

    for (const t of texts) {
        const parsed = parseDividerDate(t);
        if (parsed) return parsed;
    }

    return null;
}

function formatTimestamp(date, timeText) {
    if (!date) return null;
    const y = date.getFullYear();
    const mo = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return `${y}-${mo}-${d} ${timeText || "00:00"}`;
}

/** Local-time "YYYY-MM-DD HH:MM:SS" — when THIS run scraped the row. */
function nowStamp() {
    const n = new Date();
    const pad = v => String(v).padStart(2, "0");
    return `${n.getFullYear()}-${pad(n.getMonth() + 1)}-${pad(n.getDate())} ` +
           `${pad(n.getHours())}:${pad(n.getMinutes())}:${pad(n.getSeconds())}`;
}

/**
 * Accepts "YYYY-MM-DD" or "DD-MM-YYYY" (also with / separators) and throws on
 * anything else. Without this, a bad value becomes an Invalid Date, every
 * comparison against it quietly returns false, and the cutoff stops filtering —
 * which looks like the script deciding to scrape the entire chat history.
 */
function parseSinceDate(value) {

    if (!value || typeof value !== "string") {
        throw new Error(`settings.sinceDate is missing or not a string (got: ${JSON.stringify(value)}). Expected "YYYY-MM-DD".`);
    }

    const trimmed = value.trim();
    let year, month, day;

    let m = trimmed.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);   // YYYY-MM-DD
    if (m) {
        [, year, month, day] = m;
    } else {
        m = trimmed.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);   // DD-MM-YYYY
        if (m) {
            [, day, month, year] = m;
            console.log(`  ℹ️ settings.sinceDate "${trimmed}" read as DD-MM-YYYY. Prefer "YYYY-MM-DD" to avoid ambiguity.`);
        } else {
            throw new Error(`settings.sinceDate "${trimmed}" is not a recognised date. Use "YYYY-MM-DD", e.g. "2026-08-01".`);
        }
    }

    const d = new Date(Number(year), Number(month) - 1, Number(day));

    if (isNaN(d.getTime()) || d.getMonth() !== Number(month) - 1) {
        throw new Error(`settings.sinceDate "${trimmed}" is not a real calendar date.`);
    }

    return d;
}

/**
 * WhatsApp shows "Click here to get older messages from your phone." once the
 * browser's local history runs out. Waiting does nothing — it loads only on
 * click. Returns true if it clicked, so the caller can keep scrolling instead
 * of concluding it has reached the top of the chat.
 */
async function clickLoadOlderMessages(page) {

    const loader = page
        .getByText(/get older messages from your phone/i)
        .first();

    const visible = await loader.isVisible().catch(() => false);
    if (!visible) return false;

    console.log("  📥 'Get older messages from your phone' found — clicking to load more history...");

    const clicked = await loader.click({ timeout: 5000 }).then(() => true).catch(() => false);

    if (!clicked) {
        console.log("  ⚠️ Could not click the load-older-messages button.");
        return false;
    }

    // Fetching from the phone is slow; give it room before scrolling again.
    await page.waitForTimeout(5000);
    return true;
}

/**
 * Works out where this run should start for a given group.
 *
 * Normally that is one day BEFORE the newest message already recorded — the
 * overlap re-checks the boundary day, which is cheap (existsByMessageId skips
 * anything already stored) and covers messages that arrived late or whose
 * party label only resolved afterwards.
 *
 * Never goes earlier than settings.sinceDate, so the configured value stays a
 * hard floor. Set settings.autoSinceDate = false to always use it verbatim.
 */
async function resolveCutoffDate(database, groupName) {

    const configured = parseSinceDate(settings.sinceDate);

    if (settings.autoSinceDate === false) {
        return configured;
    }

    try {
        const lastDate = await database.getLastMessageDate(groupName);

        if (lastDate) {
            const d = new Date(`${lastDate}T00:00:00`);

            if (!isNaN(d.getTime())) {
                d.setDate(d.getDate() - 1);

                if (d > configured) {
                    console.log(`  🔄 Last processed message in "${groupName}" was ${lastDate} — starting from ${d.toDateString()} (one day overlap).`);
                    return d;
                }
            }
        }
    } catch (err) {
        console.log(`  ⚠️ Could not read last processed date (${err.message}) — using settings.sinceDate.`);
    }

    return configured;
}

/**
 * WhatsApp Web shows "What's new" and similar dialogs after an update. They sit
 * over everything, so scrolling and clicking silently do nothing until they are
 * closed — which on an unattended run looks like the scraper simply losing
 * messages. Called before and during collection so a dialog that appears
 * mid-run does not strand it.
 */
async function dismissDialogs(page) {

    const dismissed = await page.evaluate(() => {

        const labels = /^(continue|got it|ok|okay|dismiss|not now|later|close|skip)$/i;

        const dialogs = Array.from(document.querySelectorAll('[role="dialog"], [data-animate-modal-body="true"]'))
            .filter(d => d.offsetWidth > 0 || d.offsetHeight > 0);

        if (dialogs.length === 0) return null;

        for (const dialog of dialogs) {

            const heading = (dialog.innerText || "").split("\n")[0].slice(0, 60);

            // Prefer a real button with a known label.
            const buttons = Array.from(dialog.querySelectorAll('button, [role="button"]'));

            const match = buttons.find(b => labels.test((b.innerText || "").trim()));
            if (match) { match.click(); return heading; }

            // Otherwise the close X.
            const closer = dialog.querySelector('[data-icon="x"], [aria-label="Close"], [data-testid="btn-closer"]');
            if (closer) { closer.click(); return heading; }
        }

        return null;

    }).catch(() => null);

    if (dismissed) {
        console.log(`  🪟 Closed WhatsApp dialog: "${dismissed}"`);
        await page.waitForTimeout(1500);
        return true;
    }

    return false;
}

class Sidebar {
    constructor(page) {
        this.page = page;
    }

    /**
     * Blocks until WhatsApp Web has actually finished its cold-start sync.
     * Call this ONCE after the page loads, before selectUnread()/processWatchlist().
     *
     * A morning run reconnects after hours offline, so the app shows a progress
     * bar and fills the sidebar progressively. "Chat list element exists" is not
     * the same as "chat list is populated" — this waits for the row count to stop
     * changing, which is the only reliable signal that sync has settled.
     */
    async waitUntilReady() {

        const deadline = Date.now() + APP_READY_TIMEOUT;
        console.log(`⏳ Waiting for WhatsApp Web to finish loading (up to ${Math.round(APP_READY_TIMEOUT / 60000)} min)...`);

        const searchBox = this.page.locator('input[aria-label="Search or start a new chat"], input[data-tab="3"]').first();

        let lastCount = -1;
        let stablePolls = 0;
        let lastLogged = 0;

        while (Date.now() < deadline) {

            // 1. Dead session — fail fast instead of burning 15 minutes.
            const needsLogin = await this.page
                .locator('canvas[aria-label*="Scan"], [data-testid="qrcode"], [data-testid="qrcode-container"]')
                .first()
                .isVisible()
                .catch(() => false);

            if (needsLogin) {
                throw new Error("WhatsApp Web is showing the QR / login screen — the saved session has expired. Re-scan the code, then re-run.");
            }

            // 2. Still syncing? Progress bar or a loading/connecting banner.
            const progressBar = await this.page
                .locator('[role="progressbar"]')
                .first()
                .isVisible()
                .catch(() => false);

            const loadingText = await this.page
                .getByText(/loading your chats|syncing|connecting|initializing|trying to reach/i)
                .first()
                .isVisible()
                .catch(() => false);

            if (progressBar || loadingText) {
                lastCount = -1;
                stablePolls = 0;
                if (Date.now() - lastLogged > 15000) {
                    console.log("  … still syncing (progress indicator visible)");
                    lastLogged = Date.now();
                }
                await this.page.waitForTimeout(3000);
                continue;
            }

            // 3. Sidebar populated and search usable?
            const rowCount = await this.page.locator('[data-testid^="list-item-"]').count().catch(() => 0);
            const searchReady = await searchBox.isVisible().catch(() => false);

            if (rowCount > 0 && searchReady) {
                if (rowCount === lastCount) {
                    stablePolls++;
                    if (stablePolls >= 3) {
                        console.log(`✅ WhatsApp Web ready — ${rowCount} chat(s) in sidebar. Settling ${POST_READY_SETTLE / 1000}s...`);
                        await this.page.waitForTimeout(POST_READY_SETTLE);
                        await dismissDialogs(this.page);
                        return true;
                    }
                } else {
                    stablePolls = 0;
                }
            } else {
                stablePolls = 0;
            }

            if (Date.now() - lastLogged > 15000) {
                console.log(`  … sidebar has ${rowCount} row(s), search ${searchReady ? "ready" : "not ready"} — waiting for it to stabilise`);
                lastLogged = Date.now();
            }

            lastCount = rowCount;
            await this.page.waitForTimeout(2000);
        }

        // Deadline hit. If there is *something* in the sidebar, a partial run beats
        // no run — a scheduled job that throws every morning does nothing at all.
        const finalCount = await this.page.locator('[data-testid^="list-item-"]').count().catch(() => 0);

        if (finalCount > 0) {
            console.log(`⚠️ Readiness timeout after ${Math.round(APP_READY_TIMEOUT / 60000)} min, but ${finalCount} chat(s) are visible — proceeding anyway.`);
            return true;
        }

        try {
            await this.page.screenshot({ path: `debug_not_ready_${Date.now()}.png`, fullPage: true });
        } catch (err) {
            // ignore
        }

        throw new Error(`WhatsApp Web never finished loading within ${Math.round(APP_READY_TIMEOUT / 60000)} minutes — sidebar is still empty. See debug_not_ready_*.png.`);
    }

    async selectUnread() {

        console.log("Selecting Unread filter...");

        const unreadButton = this.page
            .locator('button')
            .filter({ hasText: /^Unread/i })
            .first();

        await unreadButton.waitFor({
            state: "visible",
            timeout: 5000
        });

        await unreadButton.click();

        await this.page.waitForTimeout(1500);

        console.log("Unread filter selected.");

    }

    async processWatchlist(database, downloader) {

        const processedNames = new Set();
        let totalSaved = 0;

        const searchBox = this.page.locator('input[aria-label="Search or start a new chat"], input[data-tab="3"]').first();

        for (const watchEntry of watchList) {

            const watchName = watchEntry.name;
            console.log(`Searching for: "${watchName}"`);

            // An update dialog can appear at any point and blocks every click.
            await dismissDialogs(this.page);

            let matchedTitles = [];
            let searchSucceeded = false;

            for (let attempt = 1; attempt <= 3 && !searchSucceeded; attempt++) {
                try {
                    await this.page.mouse.move(200, 300);
                    await this.page.waitForTimeout(300);

                    await searchBox.waitFor({ state: "visible", timeout: 10000 });

                    await searchBox.click();
                    await this.page.waitForTimeout(300);

                    await searchBox.fill("");
                    await this.page.waitForTimeout(500);

                    const firstWord = watchName.trim().split(" ")[0];
                    await searchBox.fill(firstWord);

                    searchSucceeded = true;

                } catch (err) {
                    console.log(`  ⚠️ Search attempt ${attempt} failed for "${watchName}": ${err.message}`);

                    try {
                        const screenshotPath = `debug_search_attempt${attempt}_${Date.now()}.png`;
                        await this.page.screenshot({ path: screenshotPath });
                        console.log(`  📸 Debug screenshot (attempt ${attempt}) saved: ${screenshotPath}`);

                        const inputsHtml = await this.page.evaluate(() => {
                            const inputs = document.querySelectorAll('input');
                            return Array.from(inputs).map(el => el.outerHTML).join('\n\n---\n\n');
                        });

                        const htmlPath = `debug_search_inputs_attempt${attempt}_${Date.now()}.html`;
                        fs.writeFileSync(htmlPath, inputsHtml || "NO INPUT ELEMENTS FOUND AT ALL");
                        console.log(`  📄 Debug HTML saved: ${htmlPath}`);

                    } catch (debugErr) {
                        console.log(`  (couldn't capture debug info: ${debugErr.message})`);
                    }

                    if (attempt < 3) {
                        await this.page.waitForTimeout(2000);
                    }
                }
            }

            if (!searchSucceeded) {
                console.log(`  ❌ Giving up on "${watchName}" after 3 attempts.`);
                continue;
            }

            try {
                try {
                    console.log(`  ⏳ Waiting up to ${SEARCH_RESULTS_TIMEOUT / 1000}s for search results...`);
                    await this.page.locator('[data-testid^="list-item-"]').first().waitFor({
                        state: "visible",
                        timeout: SEARCH_RESULTS_TIMEOUT
                    });
                } catch (err) {
                    console.log(`  ⚠️ No search results appeared for "${watchName}" within ${SEARCH_RESULTS_TIMEOUT / 1000}s.`);
                }

                // Let the result list settle — the first row can render before
                // the rest of the matches arrive.
                await this.page.waitForTimeout(2000);

                const results = this.page.locator('[data-testid^="list-item-"]');
                const resultCount = await results.count();

                console.log(`  Found ${resultCount} search result(s) for "${watchName}"`);

                for (let i = 0; i < resultCount; i++) {

                    const chat = results.nth(i);

                    try {
                        const title = await chat
                            .locator("span[title]")
                            .first()
                            .getAttribute("title", { timeout: 3000 });

                        if (!title) continue;

                        const cleanTitle = title.trim().toLowerCase();
                        const escapedName = watchName.trim().toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                        const wordBoundaryRegex = new RegExp(`\\b${escapedName}\\b`, 'i');

                        if (wordBoundaryRegex.test(cleanTitle) && !matchedTitles.includes(title)) {
                            matchedTitles.push(title);
                        }

                    } catch (err) {
                        // skip problematic row
                    }
                }

            } catch (err) {
                console.log(`  ⚠️ Error scanning results for "${watchName}": ${err.message}`);
                continue;
            }

            for (const title of matchedTitles) {

                if (processedNames.has(title)) {
                    console.log(`  ⏭ Already processed "${title}" this run — skipping.`);
                    continue;
                }
                processedNames.add(title);

                console.log(`--- Processing: ${title} ---`);

                try {
                    const freshChat = this.page.locator('[data-testid^="list-item-"]').filter({
                        has: this.page.locator(`span[title="${title}"]`)
                    }).first();

                    await freshChat.waitFor({ state: "visible", timeout: 30000 });
                    await freshChat.click();

                    try {
                        await searchBox.click();
                        await searchBox.fill("");
                        await this.page.keyboard.press("Escape");
                        await this.page.waitForTimeout(500);
                    } catch (err) {
                        // ignore cleanup errors
                    }

                    try {
                        console.log(`  ⏳ Waiting up to ${CHAT_LOAD_TIMEOUT / 1000}s for chat "${title}" to load...`);
                        await this.page.locator('header').filter({ hasText: title.split(" ")[0] }).first().waitFor({
                            state: "visible",
                            timeout: CHAT_LOAD_TIMEOUT
                        });
                        console.log(`  Confirmed chat header for "${title}"`);
                    } catch (err) {
                        console.log(`  ⚠️ Could not confirm chat header for "${title}" within ${CHAT_LOAD_TIMEOUT / 1000}s — proceeding anyway.`);
                    }

                    await this.page.waitForTimeout(1500);

                    console.log(`  Processing images in "${title}"...`);
                    const savedCount = await this.collectAndDownloadNewImages(this.page, database, downloader, title, watchEntry.label);
                    console.log(`  Saved ${savedCount} new image(s) in "${title}"`);
                    totalSaved += savedCount;

                    await this.page.waitForTimeout(3000);

                } catch (err) {
                    console.log(`❌ Failed to process "${title}": ${err.message}`);
                }
            }
        }

        try {
            await searchBox.click();
            await searchBox.fill("");
            await this.page.keyboard.press("Escape");
        } catch (err) {
            // ignore cleanup errors
        }

        console.log(`Total images saved this run: ${totalSaved}`);
        return totalSaved;
    }

    async collectAndDownloadNewImages(page, database, downloader, groupName, staticPartyLabel = null) {

        const trackPartyLabels = staticPartyLabel === null; // no static label means use dynamic extraction

        let messagesAppeared = false;

        for (let attempt = 1; attempt <= 2 && !messagesAppeared; attempt++) {
            const attemptTimeout = attempt === 1 ? CHAT_LOAD_TIMEOUT : CHAT_LOAD_RETRY_TIMEOUT;
            try {
                console.log(`  ⏳ Attempt ${attempt}: waiting up to ${attemptTimeout / 1000}s for messages to render...`);
                await page.locator('[data-testid="msg-container"]').first().waitFor({
                    state: "visible",
                    timeout: attemptTimeout
                });
                messagesAppeared = true;
            } catch (err) {
                console.log(`  ⚠️ Attempt ${attempt}: no messages appeared yet — waiting and retrying...`);
                await page.waitForTimeout(5000);
            }
        }

        if (!messagesAppeared) {
            console.log("  ⚠️ No messages appeared after retries — chat may be empty or still loading.");
            return 0;
        }

        const container = page.locator('[data-testid="conversation-panel-messages"]');
        const box = await container.boundingBox();

        if (box) {
            console.log(`  Scroll container box: x=${box.x.toFixed(0)}, y=${box.y.toFixed(0)}, width=${box.width.toFixed(0)}, height=${box.height.toFixed(0)}`);
            await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        } else {
            console.log("  ⚠️ Could not get bounding box for scroll container — scrolling will not work!");
        }

        console.log("  Scrolling down to reach the newest message first...");
        let previousBottomCount = 0;
        let stableBottomCount = 0;

        for (let i = 0; i < 30; i++) {

            // Same reasoning as Phase 2: the rendered row count is constant
            // under virtualization, so only the scroll position tells the truth.
            const state = await container.evaluate(el => ({
                top: el.scrollTop,
                height: el.clientHeight,
                total: el.scrollHeight
            })).catch(() => null);

            if (state && (state.total - state.top - state.height) < 60) {
                stableBottomCount++;
                if (stableBottomCount >= 2) {
                    console.log("  Reached the bottom (newest message).");
                    break;
                }
            } else {
                stableBottomCount = 0;
            }

            if (box) {
                await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
                for (let w = 0; w < 3; w++) {
                    await page.mouse.wheel(0, 800);
                    await page.waitForTimeout(300);
                }
            }
            await page.waitForTimeout(700);
        }

        console.log("  Waiting extra time for newest messages to fully render...");
        await page.waitForTimeout(3000);

        await dismissDialogs(page);

        const cutoffDate = await resolveCutoffDate(database, groupName);

        const endDateExclusive = new Date();
        endDateExclusive.setHours(0, 0, 0, 0);

        if (cutoffDate >= endDateExclusive) {
            console.log(`  ⚠️ sinceDate (${cutoffDate.toDateString()}) is today or later, and today is excluded — nothing can match. Skipping "${groupName}".`);
            return 0;
        }

        console.log(`  📆 Date window: >= ${cutoffDate.toDateString()} and < ${endDateExclusive.toDateString()} (today excluded)`);

        const dividerLocator = () => container.locator(
            'xpath=.//div[@tabindex="-1" and .//span[@dir="auto"] and not(.//*[@data-testid="msg-container"]) and not(.//*[@data-testid="image-album"]) and not(@role)]'
        );

        console.log("  --- Phase 1: scrolling up to find cutoff boundary ---");

        let stableCount = 0;
        let reachedCutoff = false;
        const maxScrollsUp = 100;

        for (let i = 0; i < maxScrollsUp && !reachedCutoff; i++) {

            const dividers = dividerLocator();
            const dividerCount = await dividers.count();

            for (let d = 0; d < dividerCount; d++) {
                const dividerText = await dividers.nth(d)
                    .locator('span[dir="auto"]')
                    .first()
                    .innerText({ timeout: 1500 })
                    .catch(() => null);

                console.log(`DEBUG | groupName: ${groupName} | dividerText: ${dividerText}`);

                if (dividerText) {
                    const parsedDate = parseDividerDate(dividerText);
                    if (parsedDate && parsedDate < cutoffDate) {
                        console.log(`  📅 Found cutoff boundary: "${dividerText}" → ${parsedDate.toDateString()}`);
                        reachedCutoff = true;
                    }
                }
            }

            if (reachedCutoff) break;

            const scrollTop = await container.evaluate(el => el.scrollTop).catch(() => null);

            if (scrollTop !== null && scrollTop <= 5) {

                // At the top of what is loaded — but that may just be the end of
                // the browser's cache, not the end of the chat. Clicking pulls
                // more history from the phone.
                const loadedMore = await clickLoadOlderMessages(page);

                if (loadedMore) {
                    stableCount = 0;
                    continue;
                }

                stableCount++;
                if (stableCount >= 4) {
                    console.log("  Reached top of chat during Phase 1 — no cutoff date found.");
                    break;
                }
            } else {
                stableCount = 0;
            }

            if (box) {
                await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
                await page.mouse.wheel(0, -400);
            }
            await page.waitForTimeout(600);
        }

        console.log("  --- Phase 1 complete. Now at oldest boundary within range. ---");

        console.log("  --- Phase 2: scrolling down, collecting images ---");

        const imageMap = new Map();
        let currentDividerDate = null;
        let previousBottomCount2 = 0;
        let stableBottomCount2 = 0;
        let unknownDateSkips = 0;
        let reachedToday = false;
        let todayHits = 0;
        const maxScrollsDown = 150;
        const pendingLabelQueue = []; // tracks images awaiting a party-label text message (only used if trackPartyLabels)

        const itemsQuery = () => container.locator(
            'xpath=.//div[@role="row"] | .//div[@tabindex="-1" and .//span[@dir="auto"] and not(.//*[@data-testid="msg-container"]) and not(.//*[@data-testid="image-album"]) and not(@role)]'
        );

        for (let i = 0; i < maxScrollsDown; i++) {

            // Each pass rescans the rendered window from the top. A date carried
            // over from the previous pass would be applied to rows that sit ABOVE
            // the divider it came from, so the context must start empty.
            currentDividerDate = null;
            pendingLabelQueue.length = 0;

            // One read of the whole rendered conversation, top to bottom. Far
            // more reliable than resolving each row's date from its siblings.
            const dateMap = await buildDateMap(container);

            const items = itemsQuery();
            const itemCount = await items.count();

            for (let r = 0; r < itemCount; r++) {

                const item = items.nth(r);
                const role = await item.getAttribute('role').catch(() => null);

                if (role === null) {
                    // Element vanished from the DOM (virtualized away) between counting and processing — skip it safely
                    continue;
                }

                if (role !== 'row') {
                    const dividerText = await item
                        .locator('span[dir="auto"]')
                        .first()
                        .innerText({ timeout: 1500 })
                        .catch(() => null);

                    if (dividerText) {
                        const parsedDate = parseDividerDate(dividerText);
                        if (parsedDate) {
                            currentDividerDate = parsedDate;
                            console.log(`  📅 Date context: "${dividerText}" → ${parsedDate.toDateString()}`);

                            // Messages are chronological: everything below a
                            // today divider is out of window, so stop here.
                            if (STOP_AT_TODAY && parsedDate >= endDateExclusive) {
                                console.log(`  🛑 Hit "${dividerText}" — everything below is out of window. Stopping collection.`);
                                reachedToday = true;
                                break;
                            }
                        }
                    }
                    continue;
                }

                const row = item;

                const albumCount = await row.locator('[data-testid="image-album"]').count();

                if (albumCount > 0) {

                    const albumRow = row.locator('[data-testid="image-album"]').first();
                    const msgId = await albumRow.evaluate(el => {
                        const holder = el.closest("[data-id]");
                        return holder ? holder.getAttribute("data-id") : null;
                    }).catch(() => null);

                    // Same reasoning as the single-image branch: an album photo
                    // WhatsApp has not fetched yet has an image-thumb but no
                    // media-url-provider, so counting providers alone under-counts
                    // the album and the unloaded photos are never downloaded.
                    const albumProviders = await albumRow.locator('[data-testid="media-url-provider"]').count();
                    const albumThumbs = await albumRow.locator('[data-testid="image-thumb"]').count();

                    // WhatsApp encodes the true photo count as the last segment of
                    // the album id, e.g. "album-<first>-<last>-5".
                    let declaredCount = 0;
                    if (msgId) {
                        const tail = String(msgId).match(/-(\d+)$/);
                        if (tail) declaredCount = parseInt(tail[1], 10);
                    }

                    const mediaCount = Math.max(albumProviders, albumThumbs, declaredCount);

                    if (!msgId || mediaCount === 0 || imageMap.has(msgId)) continue;

                    // Logged after the dedupe check, so it appears once per album
                    // rather than on every scroll pass.
                    if (mediaCount > albumProviders) {
                        console.log(`  ⏳ Album has ${mediaCount} photo(s) but only ${albumProviders} tile(s) — will page through the viewer for the rest.`);
                    }

                    // Prefer the message's own timestamp; fall back to the nearest
                    // divider above this row, then to the running scroll context.
                    const stamp = await readMessageDateTime(albumRow);
                    let effectiveDate = stamp ? stamp.date : null;

                    const mapped = dateMap.get(msgId);

                    if (!effectiveDate && mapped) effectiveDate = mapped.date;

                    if (!effectiveDate) {
                        effectiveDate = (await readNearestDividerDate(row))
                            || (await readNeighbourDate(row))
                            || currentDividerDate;
                    }

                    // Fail CLOSED: unknown date means we do not know whether it is
                    // inside the window, so skip. A later scroll pass will see it
                    // again with a divider in view.
                    if (!effectiveDate) {
                        unknownDateSkips++;
                        console.log(`  ⚠️ Skipping ALBUM ${msgId} — no timestamp attribute and no divider found above it.`);
                        continue;
                    }
                    if (effectiveDate < cutoffDate) continue;
                    if (effectiveDate >= endDateExclusive) continue;

                    let timeText = stamp ? stamp.timeText : null;
                    if (!timeText) {
                        timeText = await albumRow
                            .locator('[data-testid="msg-meta"] span')
                            .first()
                            .innerText({ timeout: 1500 })
                            .catch(() => "00:00");
                    }

                    let sortKey;
                    if (stamp) {
                        sortKey = stamp.timestamp.getTime();
                    } else {
                        sortKey = effectiveDate.getTime();
                        const timeMatch = timeText.match(/(\d{1,2}):(\d{2})/);
                        if (timeMatch) {
                            sortKey += (parseInt(timeMatch[1]) * 60 + parseInt(timeMatch[2])) * 60000;
                        }
                    }

                    const messageTimestamp = formatTimestamp(effectiveDate, timeText);

                    // Reject a date that contradicts the surrounding messages:
                    // chronological order makes a day-early resolution detectable.
                    const problem = await validateTimestamp(row, sortKey, timeText);

                    if (problem) {
                        unknownDateSkips++;
                        console.log(`  🚩 Skipping ALBUM ${msgId}: resolved ${messageTimestamp} is ${problem}.`);
                        continue;
                    }

                    const albumLabel = trackPartyLabels
                        ? await readFollowingLabel(row)
                        : staticPartyLabel;

                    imageMap.set(msgId, { mediaCount, sortKey, messageTimestamp, partyLabel: albumLabel });

                    if (trackPartyLabels && !albumLabel) {
                        pendingLabelQueue.push(msgId);
                    }

                    console.log(`  📸 Found image album: ${mediaCount} photo(s) (${msgId}) @ ${messageTimestamp}${albumLabel ? ` → "${albumLabel}"` : " → label pending"}`);

                    continue;
                }

                const hasMsgContainer = await row.locator('[data-testid="msg-container"]').count();
                if (hasMsgContainer === 0) continue;

                const msg = row.locator('[data-testid="msg-container"]').first();

                // media-url-provider only exists once WhatsApp has actually
                // fetched the image. image-thumb is present either way, so an
                // image that has not loaded yet is still recognised as an image
                // instead of being mistaken for a text message and dropped.
                const allMedia = msg.locator('[data-testid="media-url-provider"]');
                const quotedMedia = msg.locator('[data-testid="quoted-message"] [data-testid="media-url-provider"]');
                const providerCount = (await allMedia.count()) - (await quotedMedia.count());

                const allThumbs = msg.locator('[data-testid="image-thumb"]');
                const quotedThumbs = msg.locator('[data-testid="quoted-message"] [data-testid="image-thumb"]');
                const thumbCount = (await allThumbs.count()) - (await quotedThumbs.count());

                const mediaCount = Math.max(providerCount, thumbCount);

                if (thumbCount > providerCount) {
                    console.log(`  ⏳ Image not fully loaded yet (${providerCount} provider(s), ${thumbCount} thumb(s)) — collecting it anyway.`);
                }

                if (mediaCount === 0) {

                    // Before treating this as text: WhatsApp only creates
                    // media-url-provider once a thumbnail has been fetched. An
                    // image that has not loaded yet is a placeholder with a
                    // download arrow — and counting it as text drops it
                    // silently, which is how whole stretches of a chat vanish.
                    const looksLikeUnloadedImage = await row.evaluate(el => {

                        if (el.querySelector('[data-testid="media-url-provider"]')) return false;

                        const hasDownload = !!el.querySelector(
                            '[data-icon*="download"], [data-testid*="download"], [data-icon="media-download"]'
                        );

                        const imgs = Array.from(el.querySelectorAll("img"))
                            .filter(i => !i.closest('[data-testid="quoted-message"]'))
                            .filter(i => (i.width > 40 || i.height > 40));

                        return hasDownload || imgs.length > 0;

                    }).catch(() => false);

                    if (looksLikeUnloadedImage) {
                        const when = await row
                            .locator('[data-testid="msg-meta"] span')
                            .first()
                            .innerText({ timeout: 1000 })
                            .catch(() => "??:??");

                        console.log(`  🖼️ Image at ${when} has not loaded yet (no media-url-provider) — clicking to load it.`);

                        // Clicking the bubble makes WhatsApp fetch the media.
                        // It will be picked up on a later scroll pass.
                        await row.click({ timeout: 5000 }).catch(() => {});
                        await page.waitForTimeout(1500);
                        await page.keyboard.press("Escape").catch(() => {});
                        await page.waitForTimeout(500);

                        continue;
                    }

                    // Text-only message: may be the party label for preceding images.
                    // Deliberately NOT date-filtered — a label typed today still
                    // belongs to the images it follows.
                    if (trackPartyLabels) {
                        const labelText = await msg
                            .locator('[data-testid="selectable-text"] > span')
                            .first()
                            .innerText({ timeout: 1000 })
                            .catch(() => null);

                        if (labelText && pendingLabelQueue.length > 0) {
                            const trimmedLabel = labelText.trim();
                            console.log(`  🏷️ Applying party label "${trimmedLabel}" to ${pendingLabelQueue.length} pending image(s)`);
                            for (const pendingMsgId of pendingLabelQueue) {
                                const entry = imageMap.get(pendingMsgId);
                                if (entry) entry.partyLabel = trimmedLabel;
                            }
                            pendingLabelQueue.length = 0;
                        }
                    }

                    continue;
                }

                // data-id may sit ON the message element or on an ancestor,
                // depending on the WhatsApp Web version. closest() covers both;
                // an ancestor:: axis misses the self case and silently drops
                // every image in versions that put data-id on the container.
                const msgId = await msg.evaluate(el => {
                    const holder = el.closest("[data-id]");
                    return holder ? holder.getAttribute("data-id") : null;
                }).catch(() => null);

                if (!msgId) {
                    console.log("  ⚠️ Image message has no resolvable data-id — skipping.");
                    continue;
                }

                // Already captured, but its label may not have been resolvable
                // yet (the text message below it had not rendered). Retry now.
                if (imageMap.has(msgId)) {
                    const existing = imageMap.get(msgId);
                    if (trackPartyLabels && !existing.partyLabel) {
                        const retryLabel = await readFollowingLabel(row);
                        if (retryLabel) {
                            existing.partyLabel = retryLabel;
                            console.log(`  🏷️ Resolved label "${retryLabel}" for ${msgId}`);
                        }
                    }
                    continue;
                }

                // Prefer the message's own timestamp; fall back to the nearest
                // divider above this row, then to the running scroll context.
                // Uncaptioned images have NO data-pre-plain-text, so this
                // fallback is the normal path for them, not an edge case.
                const stamp = await readMessageDateTime(msg);
                let effectiveDate = stamp ? stamp.date : null;

                const mapped = dateMap.get(msgId);

                if (!effectiveDate && mapped) effectiveDate = mapped.date;

                if (!effectiveDate) {
                    effectiveDate = (await readNearestDividerDate(row))
                            || (await readNeighbourDate(row))
                            || currentDividerDate;
                }

                if (!effectiveDate) {
                    unknownDateSkips++;
                    console.log(`  ⚠️ Skipping ${msgId} — no timestamp attribute and no divider above it.`);
                    continue;
                }
                if (effectiveDate < cutoffDate) continue;

                if (effectiveDate >= endDateExclusive) {
                    // Two in a row before stopping, so one mis-resolved date
                    // cannot cut the run short.
                    todayHits++;
                    if (STOP_AT_TODAY && todayHits >= 2) {
                        console.log("  🛑 Reached today's images — stopping collection.");
                        reachedToday = true;
                        break;
                    }
                    continue;
                }

                todayHits = 0;

                let timeText = stamp ? stamp.timeText : null;
                if (!timeText && mapped && mapped.timeText) timeText = mapped.timeText;
                if (!timeText) {
                    timeText = await msg
                        .locator('[data-testid="msg-meta"] span')
                        .first()
                        .innerText({ timeout: 1500 })
                        .catch(() => "00:00");
                }

                let sortKey;
                if (stamp) {
                    sortKey = stamp.timestamp.getTime();
                } else {
                    sortKey = effectiveDate.getTime();
                    const timeMatch = timeText.match(/(\d{1,2}):(\d{2})/);
                    if (timeMatch) {
                        sortKey += (parseInt(timeMatch[1]) * 60 + parseInt(timeMatch[2])) * 60000;
                    }
                }

                const messageTimestamp = formatTimestamp(effectiveDate, timeText);

                // Reject a date that contradicts the surrounding messages:
                // chronological order makes a day-early resolution detectable.
                const problem = await validateTimestamp(row, sortKey, timeText);

                if (problem) {
                    unknownDateSkips++;
                    console.log(`  🚩 Skipping ${msgId}: resolved ${messageTimestamp} is ${problem}.`);
                    continue;
                }

                // Captions are deliberately IGNORED as a label source. In this
                // group the sender name is always the text message posted AFTER
                // the image; anything inside the image bubble is app boilerplate.
                const initialPartyLabel = trackPartyLabels
                    ? await readFollowingLabel(row)
                    : staticPartyLabel;

                imageMap.set(msgId, { mediaCount, sortKey, messageTimestamp, partyLabel: initialPartyLabel });

                console.log(`  📸 Found image message (${msgId}) @ ${messageTimestamp}${initialPartyLabel ? ` → "${initialPartyLabel}"` : " → label pending"}`);

                if (trackPartyLabels && !initialPartyLabel) {
                    pendingLabelQueue.push(msgId); // fallback: label may arrive later in this pass
                }
            }

            if (reachedToday) {
                console.log(`  ✅ Stopped early at scroll ${i + 1} — no need to scroll further.`);
                break;
            }

            const posLog = await container.evaluate(el =>
                `${Math.round(el.scrollTop)}/${Math.round(el.scrollHeight - el.clientHeight)}`
            ).catch(() => "?");

            console.log(`  Scroll down ${i + 1}: ${itemCount} items rendered, ${imageMap.size} unique images captured, scroll ${posLog}`);

            // Bottom detection must use the SCROLL POSITION, not the number of
            // rendered rows. WhatsApp virtualizes the list: it recycles rows as
            // you scroll, so the rendered count sits at a constant (~60-100)
            // from top to bottom. Treating "count unchanged" as "reached the
            // end" stops collection early and loses everything below.
            const scrollState = await container.evaluate(el => ({
                top: el.scrollTop,
                height: el.clientHeight,
                total: el.scrollHeight
            })).catch(() => null);

            if (scrollState) {

                const remaining = scrollState.total - scrollState.top - scrollState.height;

                if (remaining < 60) {
                    stableBottomCount2++;
                    if (stableBottomCount2 >= 3) {
                        console.log("  Reached bottom of chat during Phase 2 — finished collecting.");
                        break;
                    }
                } else {
                    stableBottomCount2 = 0;
                }

            } else {
                // Could not read the scroll position — fall back to the old
                // row-count heuristic rather than looping forever.
                const bottomCheckCount = await container
                    .locator('[data-testid="msg-container"], [data-testid="image-album"]').count();

                if (bottomCheckCount === previousBottomCount2) {
                    stableBottomCount2++;
                    if (stableBottomCount2 >= 6) {
                        console.log("  Reached bottom of chat (row count stable) — finished collecting.");
                        break;
                    }
                } else {
                    stableBottomCount2 = 0;
                }
                previousBottomCount2 = bottomCheckCount;
            }

            if (box) {
                await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
                await page.mouse.wheel(0, 400);
            }
            await page.waitForTimeout(800);
        }

        console.log(`  Found ${imageMap.size} image message(s) total in "${groupName}"`);

        if (unknownDateSkips > 0) {
            console.log(`  ℹ️ ${unknownDateSkips} row-scan(s) skipped because no date could be determined. If this number is large and images are missing, data-pre-plain-text may be absent in this chat.`);
        }

        // Final label pass: anything still unresolved gets one more try now
        // that scrolling has stopped and the DOM has settled. Without this, an
        // image whose label message rendered late keeps a NULL party_label
        // forever, because the row is never revisited.
        if (trackPartyLabels) {

            const unlabelled = Array.from(imageMap.entries()).filter(([, v]) => !v.partyLabel);

            if (unlabelled.length > 0) {
                console.log(`  🔁 Final label pass for ${unlabelled.length} image(s) with no label yet...`);

                for (const [msgId, entry] of unlabelled) {

                    const freshRow = page.locator(`[data-id="${msgId}"]`).first();

                    const visible = await freshRow.isVisible().catch(() => false);

                    if (!visible) {
                        await freshRow.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
                        await page.waitForTimeout(400);
                    }

                    const label = await readFollowingLabel(freshRow).catch(() => null);

                    if (label) {
                        entry.partyLabel = label;
                        console.log(`  🏷️ Late-resolved label "${label}" for ${msgId}`);
                    } else {
                        console.log(`  ⚠️ Still no label for ${msgId} — will store NULL.`);
                    }
                }
            }
        }

        const sortedEntries = Array.from(imageMap.entries())
            .sort((a, b) => a[1].sortKey - b[1].sortKey);

        let totalSaved = 0;
        let previousSrc = null;
        const pendingDownloads = [];

        for (const [msgId, { mediaCount, messageTimestamp, partyLabel }] of sortedEntries) {

            for (let mediaIdx = 0; mediaIdx < mediaCount; mediaIdx++) {

                const compositeId = `${msgId}_${mediaIdx}`;

                const alreadyDone = await database.existsByMessageId(compositeId);
                if (alreadyDone) {
                    console.log(`  ⏭ Skipping already-downloaded (${compositeId})`);
                    continue;
                }

                const freshMsg = page.locator(`[data-id="${msgId}"]`).first();
                const imageObj = { locator: freshMsg };

                try {
                    const result = await downloader.download(groupName, imageObj, totalSaved, previousSrc, msgId, mediaIdx);

                    if (result) {
                        console.log(`  ✓ Saved: ${result.fileName} (${compositeId})`);
                        totalSaved++;
                        previousSrc = result.src;

                        pendingDownloads.push({ compositeId, messageTimestamp, partyLabel, result });
                    }
                } catch (err) {
                    console.log(`  ❌ Failed to download ${compositeId}: ${err.message}`);
                }
            }
        }

        // ---- Hash pre-screen: an identical image already processed elsewhere
        // needs no Gemini call. Forwarded screenshots are byte-identical, so
        // this catches the common case of the same receipt in several groups.
        const needsGemini = [];

        for (const item of pendingDownloads) {

            const hash = item.result.hash;

            if (!hash) {
                needsGemini.push(item);
                continue;
            }

            try {
                const knownPayment = await database.findPaymentByHash(hash);

                if (knownPayment) {

                    // Same payment already recorded for THIS group — a repost,
                    // not a second payment. Recording it again double-counts.
                    if (knownPayment.utr && await database.utrExistsInGroup(knownPayment.utr, groupName)) {
                        console.log(`  ⏭ UTR ${knownPayment.utr} already recorded in "${groupName}" — skipping duplicate.`);
                        await database.markSeen(item.compositeId, groupName, item.result.fileName, hash);
                        try { fs.unlinkSync(item.result.filePath); } catch (err) { /* already gone */ }
                        continue;
                    }

                    console.log(`  ⚡ Identical image already processed in "${knownPayment.group_name}" — reusing its details, skipping Gemini.`);

                    await database.insert({
                        groupName: groupName,
                        imageName: item.result.fileName,
                        imagePath: item.result.filePath,
                        amount: knownPayment.amount,
                        amountValue: knownPayment.amount_value,
                        utr: knownPayment.utr,
                        date: knownPayment.payment_date,
                        time: knownPayment.payment_time,
                        sender: knownPayment.sender,
                        receiver: knownPayment.receiver,
                        bank: knownPayment.bank,
                        isPayment: 1,
                        messageId: item.compositeId,
                        imageHash: hash,
                        messageTimestamp: item.messageTimestamp,
                        partyLabel: item.partyLabel,
                        processedAt: nowStamp(),
                        foundInGroup: knownPayment.group_name
                    });

                    await database.markFoundInOtherGroupById(knownPayment.id, groupName);
                    continue;
                }

                const knownNonPayment = await database.seenNonPaymentByHash(hash);

                if (knownNonPayment) {
                    console.log(`  ⚡ Identical image already judged not-a-payment — discarding, skipping Gemini.`);
                    await database.markSeen(item.compositeId, groupName, item.result.fileName, hash);
                    try { fs.unlinkSync(item.result.filePath); } catch (err) { /* already gone */ }
                    continue;
                }

            } catch (err) {
                console.log(`  ⚠️ Hash pre-screen failed (${err.message}) — falling back to Gemini.`);
            }

            needsGemini.push(item);
        }

        if (pendingDownloads.length !== needsGemini.length) {
            console.log(`  ⚡ Hash pre-screen resolved ${pendingDownloads.length - needsGemini.length} of ${pendingDownloads.length} image(s) without calling Gemini.`);
        }

        const BATCH_SIZE = 5;

        for (let i = 0; i < needsGemini.length; i += BATCH_SIZE) {

            const batch = needsGemini.slice(i, i + BATCH_SIZE);
            const filePaths = batch.map(item => item.result.filePath);

            console.log(`  🧠 Sending batch of ${batch.length} image(s) to Gemini...`);

            let batchResults;
            try {
                batchResults = await readPaymentsBatch(filePaths);
            } catch (err) {
                console.log(`  ⚠️ Gemini batch call failed: ${err.message}`);
                batchResults = batch.map(() => ({ isPayment: false }));
            }

            for (let j = 0; j < batch.length; j++) {

                const item = batch[j];
                const paymentDetails = batchResults[j] || { isPayment: false };

                if (paymentDetails.isPayment) {
                    console.log(`  💰 Payment detected: ₹${paymentDetails.amount} to ${paymentDetails.receiver}`);
                } else {
                    // Not a payment: no row in `payments`. Record it as seen so a
                    // future run skips it, then remove the file from disk.
                    console.log(`  ➖ Not a payment screenshot: ${item.result.fileName} — discarding.`);

                    try {
                        await database.markSeen(item.compositeId, groupName, item.result.fileName, item.result.hash);
                    } catch (err) {
                        console.log(`  ⚠️ Could not record seen media: ${err.message}`);
                    }

                    try {
                        fs.unlinkSync(item.result.filePath);
                    } catch (err) {
                        console.log(`  ⚠️ Could not delete ${item.result.filePath}: ${err.message}`);
                    }

                    continue;
                }

                // Sanity check: a screenshot cannot be sent BEFORE the payment
                // it shows. If the extracted payment date is later than the
                // message date, the message date was resolved wrongly — which
                // is how a message sent today ends up dated yesterday and slips
                // into a window that excludes today.
                if (paymentDetails.isPayment && paymentDetails.date && item.messageTimestamp) {

                    const paymentDay = new Date(`${paymentDetails.date}T00:00:00`);
                    const messageDay = new Date(`${item.messageTimestamp.slice(0, 10)}T00:00:00`);

                    if (!isNaN(paymentDay) && !isNaN(messageDay) && paymentDay > messageDay) {
                        console.log(`  🚩 Discarding ${item.result.fileName}: payment dated ${paymentDetails.date} but message dated ${item.messageTimestamp.slice(0, 10)} — the message date is wrong, so this row is not trustworthy.`);

                        // Deliberately NOT marked as seen: once the date logic
                        // resolves it correctly, the next run should pick it up.
                        try { fs.unlinkSync(item.result.filePath); } catch (err) { /* already gone */ }
                        continue;
                    }
                }

                let foundInGroup = null;

                if (paymentDetails.isPayment && paymentDetails.utr) {

                    if (await database.utrExistsInGroup(paymentDetails.utr, groupName)) {
                        console.log(`  ⏭ UTR ${paymentDetails.utr} already recorded in "${groupName}" — skipping duplicate.`);
                        await database.markSeen(item.compositeId, groupName, item.result.fileName, item.result.hash);
                        try { fs.unlinkSync(item.result.filePath); } catch (err) { /* already gone */ }
                        continue;
                    }

                    const existingRecord = await database.findByUTR(paymentDetails.utr);
                    if (existingRecord) {
                        // One column carries the link both ways: this row points
                        // at where the UTR was first seen, and that row is updated
                        // to point back here.
                        foundInGroup = existingRecord.group_name;

                        console.log(`  ♻️ Duplicate payment (UTR ${paymentDetails.utr}) — first recorded in "${existingRecord.group_name}". Adding a row for "${groupName}" that references it.`);

                        await database.markFoundInOtherGroupById(existingRecord.id, groupName);
                    }
                }

                if (!item.messageTimestamp) {
                    console.log(`  ⚠️ No message timestamp resolved for ${item.compositeId} — inserting NULL. Check the date-context logs above.`);
                }

                try {
                    await database.insert({
                        groupName: groupName,
                        imageName: item.result.fileName,
                        imagePath: item.result.filePath,
                        amount: paymentDetails.amount || null,
                        amountValue: paymentDetails.amount || null,
                        utr: paymentDetails.utr || null,
                        date: paymentDetails.date || null,
                        time: paymentDetails.time || null,
                        sender: paymentDetails.sender || null,
                        receiver: paymentDetails.receiver || null,
                        bank: paymentDetails.bank || null,
                        isPayment: paymentDetails.isPayment ? 1 : 0,
                        messageId: item.compositeId,
                        imageHash: item.result.hash,
                        messageTimestamp: item.messageTimestamp,
                        partyLabel: item.partyLabel,
                        processedAt: nowStamp(),
                        foundInGroup: foundInGroup
                    });
                } catch (err) {
                    // Loud, but non-fatal: one bad row must not abort the rest
                    // of the chat (and the file stays on disk for a re-run).
                    console.log(`  ❌ DB insert failed for ${item.result.fileName}: ${err.message}`);
                }
            }

            await page.waitForTimeout(1500);
        }

        return totalSaved;
    }
}

module.exports = Sidebar;
