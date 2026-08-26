// src/report.js
//
// Prints the day's payment summary to stdout at the end of a run, so it lands
// in logs\run_YYYYMMDD.log alongside everything else.
//
// Defaults to YESTERDAY, because the scrape window deliberately excludes today.

console.log(">>> LOADED:", __filename);

const fs = require("fs");
const path = require("path");

const RAMESH_MATCH = "%Ramesh%";
const REPORT_DIR = "reports";

function yesterdayISO() {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    const pad = v => String(v).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 1234567.5 -> "12,34,567.50"  (Indian grouping) */
function inr(value) {
    if (value === null || value === undefined) return "-";

    const num = Number(value);
    if (isNaN(num)) return String(value);

    const fixed = Math.abs(num).toFixed(2);
    const [whole, decimals] = fixed.split(".");

    let grouped;
    if (whole.length <= 3) {
        grouped = whole;
    } else {
        const last3 = whole.slice(-3);
        const rest = whole.slice(0, -3);
        grouped = rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",") + "," + last3;
    }

    return `${num < 0 ? "-" : ""}${grouped}.${decimals}`;
}

function pad(text, width, align = "left") {
    const s = String(text === null || text === undefined ? "-" : text);
    if (s.length >= width) return s.slice(0, width);
    const fill = " ".repeat(width - s.length);
    return align === "right" ? fill + s : s + fill;
}

function rule(char = "─", width = 78) {
    return char.repeat(width);
}

async function printDailyReport(database, dateISO = yesterdayISO(), options = {}) {

    const { toConsole = false } = options;

    const lines = [];
    const out = text => {
        lines.push(text === undefined ? "" : text);
        if (toConsole) out(text === undefined ? "" : text);
    };


    out("");
    out(rule("═"));
    out(`  PAYMENT REPORT — ${dateISO}`);
    out(rule("═"));

    // ---------------------------------------------------------------
    // 1. Ramesh — every payment individually, in message order
    // ---------------------------------------------------------------
    const rameshRows = await database.query(`
        SELECT message_timestamp, party_label, amount_value, utr, found_in_group
        FROM payments
        WHERE group_name LIKE ?
          AND is_payment = 1
          AND DATE(message_timestamp) = ?
        ORDER BY message_timestamp
    `, [RAMESH_MATCH, dateISO]);

    out("");
    out("  RAMESH PAYMENT — individual");
    out("  " + rule("─", 76));
    out("  " + pad("Time", 7) + pad("Party", 24) + pad("Amount", 14, "right") + "  " + pad("UTR", 16) + "Dup");
    out("  " + rule("─", 76));

    if (rameshRows.length === 0) {
        out("  (no payments)");
    } else {
        for (const r of rameshRows) {
            const time = (r.message_timestamp || "").slice(11, 16) || "--:--";
            out(
                "  " +
                pad(time, 7) +
                pad(r.party_label || "(no label)", 24) +
                pad(inr(r.amount_value), 14, "right") + "  " +
                pad(r.utr || "-", 16) +
                (r.found_in_group ? `← ${r.found_in_group}` : "")
            );
        }
    }

    const rameshTotal = rameshRows.reduce((sum, r) => sum + (Number(r.amount_value) || 0), 0);

    out("  " + rule("─", 76));
    out("  " + pad(`TOTAL (${rameshRows.length} payments)`, 31) + pad(inr(rameshTotal), 14, "right"));

    // ---------------------------------------------------------------
    // 2. Ramesh — same day, grouped by party (case-insensitive)
    // ---------------------------------------------------------------
    const byParty = await database.query(`
        SELECT TRIM(LOWER(party_label)) AS party,
               COUNT(*) AS payments,
               SUM(amount_value) AS total
        FROM payments
        WHERE group_name LIKE ?
          AND is_payment = 1
          AND DATE(message_timestamp) = ?
        GROUP BY party
        ORDER BY total DESC
    `, [RAMESH_MATCH, dateISO]);

    if (byParty.length > 0) {
        out("");
        out("  RAMESH PAYMENT — by party");
        out("  " + rule("─", 76));
        for (const p of byParty) {
            out(
                "  " +
                pad(p.party || "(no label)", 30) +
                pad(`${p.payments}x`, 6, "right") +
                pad(inr(p.total), 16, "right")
            );
        }
    }

    // ---------------------------------------------------------------
    // 3. All other groups — totals and how many were duplicates
    // ---------------------------------------------------------------
    const otherRows = await database.query(`
        SELECT group_name,
               party_label,
               COUNT(*) AS payments,
               SUM(amount_value) AS total,
               SUM(CASE WHEN found_in_group IS NOT NULL THEN 1 ELSE 0 END) AS dup_count,
               SUM(CASE WHEN found_in_group IS NOT NULL THEN amount_value ELSE 0 END) AS dup_amount
        FROM payments
        WHERE group_name NOT LIKE ?
          AND is_payment = 1
          AND DATE(message_timestamp) = ?
        GROUP BY group_name, party_label
        ORDER BY total DESC
    `, [RAMESH_MATCH, dateISO]);

    out("");
    out("  OTHER GROUPS");
    out("  " + rule("─", 76));
    out("  " + pad("Group", 24) + pad("Party", 18) + pad("Total", 15, "right") + pad("Dup", 6, "right") + pad("Dup amt", 13, "right"));
    out("  " + rule("─", 76));

    if (otherRows.length === 0) {
        out("  (no payments)");
    } else {
        for (const r of otherRows) {
            out(
                "  " +
                pad(r.group_name, 24) +
                pad(r.party_label || "-", 18) +
                pad(inr(r.total), 15, "right") +
                pad(r.dup_count, 6, "right") +
                pad(r.dup_amount ? inr(r.dup_amount) : "-", 13, "right")
            );
        }
    }

    const otherTotal = otherRows.reduce((sum, r) => sum + (Number(r.total) || 0), 0);
    const otherDup = otherRows.reduce((sum, r) => sum + (Number(r.dup_amount) || 0), 0);

    out("  " + rule("─", 76));
    out("  " + pad("TOTAL", 42) + pad(inr(otherTotal), 15, "right"));
    out("  " + pad("of which duplicated", 42) + pad(inr(otherDup), 15, "right"));

    // ---------------------------------------------------------------
    // 4. Grand total, duplicates counted once
    // ---------------------------------------------------------------
    const [grand] = await database.query(`
        SELECT COUNT(*) AS payments,
               SUM(amount_value) AS total,
               SUM(CASE WHEN found_in_group IS NULL THEN amount_value ELSE 0 END) AS unique_total
        FROM payments
        WHERE is_payment = 1 AND DATE(message_timestamp) = ?
    `, [dateISO]);

    out("");
    out(rule("═"));
    out(`  ALL GROUPS: ${grand.payments || 0} payments, ${inr(grand.total)} gross`);
    out(`  Excluding cross-group duplicates: ${inr(grand.unique_total)}`);
    out(rule("═"));
    out("");

    // ---------------------------------------------------------------
    // 5. Rows worth a human look
    // ---------------------------------------------------------------
    const suspect = await database.query(`
        SELECT group_name, message_timestamp, party_label, amount, amount_value, utr
        FROM payments
        WHERE is_payment = 1
          AND DATE(message_timestamp) = ?
          AND (amount_value IS NULL OR amount_value = 0
               OR utr IS NULL OR utr = ''
               OR party_label IS NULL)
    `, [dateISO]);

    if (suspect.length > 0) {
        out(`  ⚠️ ${suspect.length} row(s) need review (missing amount, UTR or label):`);
        for (const r of suspect) {
            out(`     ${r.message_timestamp}  ${r.group_name}  amount=${r.amount || "-"}  utr=${r.utr || "-"}  label=${r.party_label || "-"}`);
        }
        out("");
    }

    // ---------------------------------------------------------------
    // Write to its own file rather than burying it in the run log.
    // ---------------------------------------------------------------
    try {
        fs.mkdirSync(REPORT_DIR, { recursive: true });

        const filePath = path.join(REPORT_DIR, `payment_report_${dateISO}.txt`);
        fs.writeFileSync(filePath, lines.join("\n"), "utf8");

        console.log(`📄 Report written: ${filePath}`);
        return filePath;

    } catch (err) {
        console.log(`⚠️ Could not write report file: ${err.message}`);
        return null;
    }
}

module.exports = { printDailyReport, yesterdayISO };
