const sqlite3 = require("sqlite3").verbose();
const fs = require("fs");
const path = require("path");

// Every column the app expects, with its type. initialize() compares this
// against PRAGMA table_info and adds whatever is missing — so adding a column
// here is the ONLY step needed to migrate an existing payments.db.
const REQUIRED_COLUMNS = [
    ["group_name",          "TEXT"],
    ["image_name",          "TEXT"],
    ["image_path",          "TEXT"],
    ["amount",              "TEXT"],
    ["amount_value",        "REAL"],
    ["utr",                 "TEXT"],
    ["payment_date",        "TEXT"],
    ["payment_time",        "TEXT"],
    ["sender",              "TEXT"],
    ["receiver",            "TEXT"],
    ["bank",                "TEXT"],
    ["is_payment",          "INTEGER DEFAULT 0"],
    ["whatsapp_message_id", "TEXT"],
    ["image_hash",          "TEXT"],
    ["perceptual_hash",     "TEXT"],
    ["found_in_group",      "TEXT"],
    ["message_timestamp",   "TEXT"],
    ["party_label",         "TEXT"],
    ["processed_at",        "TEXT"]
];

/**
 * "₹1,00,000.00" / "16,000" / "8800.00" -> 100000 / 16000 / 8800
 * Stored alongside the printed text so totals can be summed directly.
 */
function toNumericAmount(value) {
    if (value === null || value === undefined) return null;

    const cleaned = String(value)
        .replace(/[₹$€£,\s]/g, "")
        .replace(/(?:rs\.?|inr)/gi, "")
        .trim();

    const match = cleaned.match(/-?\d+(?:\.\d+)?/);
    if (!match) return null;

    const num = Number(match[0]);
    return isNaN(num) ? null : num;
}

class Database {

    constructor() {

        const dbFolder = path.join(process.cwd(), "database");

        if (!fs.existsSync(dbFolder)) {
            fs.mkdirSync(dbFolder, { recursive: true });
        }

        const dbPath = path.join(dbFolder, "payments.db");

        this.db = new sqlite3.Database(dbPath);

    }

    initialize() {

        return new Promise((resolve, reject) => {

            const createSql = `
            CREATE TABLE IF NOT EXISTS payments (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                group_name TEXT NOT NULL,
                image_name TEXT NOT NULL,
                image_path TEXT NOT NULL,
                amount TEXT,
                amount_value REAL,
                utr TEXT,
                payment_date TEXT,
                payment_time TEXT,
                sender TEXT,
                receiver TEXT,
                bank TEXT,
                is_payment INTEGER DEFAULT 0,
                whatsapp_message_id TEXT,
                image_hash TEXT,
                perceptual_hash TEXT,
                found_in_group TEXT,
                message_timestamp TEXT,
                party_label TEXT,
                processed_at TEXT
            )
            `;

            this.db.run(createSql, err => {

                if (err) return reject(err);

                // Tracks media that was downloaded and inspected but is NOT a
                // payment. Keeps the payments table clean while still allowing
                // existsByMessageId() to skip it on later runs — without this,
                // every ordinary photo is re-downloaded and re-OCR'd forever.
                const seenSql = `
                CREATE TABLE IF NOT EXISTS seen_media (
                    message_id TEXT PRIMARY KEY,
                    group_name TEXT,
                    image_name TEXT,
                    reason TEXT,
                    seen_at TEXT
                )
                `;

                this.db.run(seenSql, seenErr => {

                if (seenErr) return reject(seenErr);

                // Existing databases were created with an older CREATE TABLE, so
                // ask SQLite what is actually there rather than assuming.
                this.db.all(`PRAGMA table_info(payments)`, [], (infoErr, rows) => {

                    if (infoErr) return reject(infoErr);

                    const existing = new Set(rows.map(r => r.name));
                    const missing = REQUIRED_COLUMNS.filter(([name]) => !existing.has(name));

                    if (missing.length === 0) {
                        console.log("✅ payments table ready (schema up to date)");
                        return this.createIndexes().then(resolve).catch(reject);
                    }

                    console.log(`🔧 Migrating payments table — adding ${missing.length} missing column(s): ${missing.map(c => c[0]).join(", ")}`);

                    const addNext = (i) => {

                        if (i >= missing.length) {
                            console.log("✅ payments table ready (migrated)");
                            return this.createIndexes().then(resolve).catch(reject);
                        }

                        const [name, type] = missing[i];

                        this.db.run(`ALTER TABLE payments ADD COLUMN ${name} ${type}`, alterErr => {

                            // "duplicate column name" is benign (race with another
                            // process); anything else is a real problem and must
                            // not be swallowed, or inserts will fail silently later.
                            if (alterErr && !/duplicate column name/i.test(alterErr.message)) {
                                return reject(new Error(`Failed adding column "${name}": ${alterErr.message}`));
                            }

                            console.log(`  ➕ Added column: ${name}`);
                            addNext(i + 1);

                        });

                    };

                    addNext(0);

                });

                });

            });

        });

    }

    createIndexes() {

        return new Promise((resolve, reject) => {

            const statements = [
                `CREATE INDEX IF NOT EXISTS idx_payments_msgid ON payments (whatsapp_message_id)`,
                `CREATE INDEX IF NOT EXISTS idx_payments_utr   ON payments (utr)`,
                `CREATE INDEX IF NOT EXISTS idx_payments_hash  ON payments (image_hash)`
            ];

            let done = 0;
            let failed = false;

            for (const sql of statements) {
                this.db.run(sql, err => {
                    if (failed) return;
                    if (err) { failed = true; return reject(err); }
                    if (++done === statements.length) resolve();
                });
            }

        });

    }

    insert(payment) {

        return new Promise((resolve, reject) => {

            const sql = `
                INSERT INTO payments
                (
                    group_name,
                    image_name,
                    image_path,
                    amount,
                    amount_value,
                    utr,
                    payment_date,
                    payment_time,
                    sender,
                    receiver,
                    bank,
                    is_payment,
                    whatsapp_message_id,
                    image_hash,
                    message_timestamp,
                    party_label,
                    processed_at,
                    found_in_group
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `;

            const now = new Date();
            const localTimestamp = now.getFullYear() + "-" +
                String(now.getMonth() + 1).padStart(2, "0") + "-" +
                String(now.getDate()).padStart(2, "0") + " " +
                String(now.getHours()).padStart(2, "0") + ":" +
                String(now.getMinutes()).padStart(2, "0") + ":" +
                String(now.getSeconds()).padStart(2, "0");

            this.db.run(
                sql,
                [
                    payment.groupName,
                    payment.imageName,
                    payment.imagePath,
                    payment.amount,
                    toNumericAmount(payment.amountValue !== undefined ? payment.amountValue : payment.amount),
                    payment.utr,
                    payment.date,
                    payment.time,
                    payment.sender,
                    payment.receiver,
                    payment.bank,
                    payment.isPayment ? 1 : 0,
                    payment.messageId || null,
                    payment.imageHash || null,
                    payment.messageTimestamp || null,
                    payment.partyLabel || null,
                    payment.processedAt || localTimestamp,
                    payment.foundInGroup || null
                ],
                function (err) {

                    if (err)
                        return reject(new Error(`insert failed for ${payment.imageName}: ${err.message}`));

                    resolve(this.lastID);

                }
            );

        });

    }

    getAllPerceptualHashes() {
        return new Promise((resolve, reject) => {
            const sql = `SELECT id, group_name, image_name, perceptual_hash FROM payments WHERE perceptual_hash IS NOT NULL`;
            this.db.all(sql, [], (err, rows) => {
                if (err) return reject(err);
                resolve(rows);
            });
        });
    }

    markFoundInOtherGroupById(id, groupName) {
        return new Promise((resolve, reject) => {
            const sql = `UPDATE payments SET found_in_group = ? WHERE id = ?`;
            this.db.run(sql, [groupName, id], function (err) {
                if (err) return reject(err);
                resolve(this.changes);
            });
        });
    }

    existsByUTR(utr) {

        return new Promise((resolve, reject) => {

            if (!utr) {
                resolve(false);
                return;
            }

            const sql = `
                SELECT id
                FROM payments
                WHERE utr = ?
                LIMIT 1
            `;

            this.db.get(sql, [utr], (err, row) => {

                if (err)
                    return reject(err);

                resolve(!!row);

            });

        });

    }

    findByUTR(utr) {

        return new Promise((resolve, reject) => {

            if (!utr) {
                resolve(null);
                return;
            }

            const sql = `
                SELECT id, group_name, image_name
                FROM payments
                WHERE utr = ?
                LIMIT 1
            `;

            this.db.get(sql, [utr], (err, row) => {

                if (err)
                    return reject(err);

                resolve(row || null);

            });

        });

    }

    findByHash(hash) {

        return new Promise((resolve, reject) => {

            if (!hash) {
                resolve(null);
                return;
            }

            const sql = `
                SELECT group_name, image_name
                FROM payments
                WHERE image_hash = ?
                LIMIT 1
            `;

            this.db.get(sql, [hash], (err, row) => {

                if (err)
                    return reject(err);

                resolve(row || null);

            });

        });

    }

    markFoundInOtherGroup(hash, groupName) {

        return new Promise((resolve, reject) => {

            const sql = `
                UPDATE payments
                SET found_in_group = ?
                WHERE image_hash = ?
            `;

            this.db.run(sql, [groupName, hash], function (err) {

                if (err)
                    return reject(err);

                resolve(this.changes);

            });

        });

    }

    markSeen(messageId, groupName, imageName, reason = "not_a_payment") {

        return new Promise((resolve, reject) => {

            if (!messageId) return resolve(0);

            const now = new Date();
            const pad = v => String(v).padStart(2, "0");
            const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
                          `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

            const sql = `
                INSERT OR REPLACE INTO seen_media
                (message_id, group_name, image_name, reason, seen_at)
                VALUES (?, ?, ?, ?, ?)
            `;

            this.db.run(sql, [messageId, groupName, imageName, reason, stamp], function (err) {
                if (err) return reject(err);
                resolve(this.changes);
            });

        });

    }

    existsByMessageId(messageId) {

        return new Promise((resolve, reject) => {

            if (!messageId) {
                resolve(false);
                return;
            }

            // Checks BOTH tables — a message already judged "not a payment"
            // must not be downloaded and sent to Gemini a second time.
            const sql = `
                SELECT 1 FROM payments   WHERE whatsapp_message_id = ?
                UNION ALL
                SELECT 1 FROM seen_media WHERE message_id = ?
                LIMIT 1
            `;

            this.db.get(sql, [messageId, messageId], (err, row) => {

                if (err)
                    return reject(err);

                resolve(!!row);

            });

        });

    }

    existsByImage(groupName, imageName) {

        return new Promise((resolve, reject) => {

            const sql = `
                SELECT id
                FROM payments
                WHERE group_name = ?
                  AND image_name = ?
                LIMIT 1
            `;

            this.db.get(sql, [groupName, imageName], (err, row) => {

                if (err)
                    return reject(err);

                resolve(!!row);

            });

        });

    }

    getTodaysPayments() {

        return new Promise((resolve, reject) => {

            const sql = `
                SELECT *
                FROM payments
                WHERE DATE(processed_at) = DATE('now','localtime')
                ORDER BY processed_at DESC
            `;

            this.db.all(sql, [], (err, rows) => {

                if (err)
                    return reject(err);

                resolve(rows);

            });

        });

    }

    close() {

        return new Promise((resolve, reject) => {

            this.db.close(err => {

                if (err)
                    return reject(err);

                resolve();

            });

        });

    }

}

module.exports = Database;
