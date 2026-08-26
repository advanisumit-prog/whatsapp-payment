// runReport.js  (project root)
//
// Regenerates the report without touching WhatsApp. Useful after editing the
// database, or to look at a day other than yesterday.
//
//   node runReport.js                 -> yesterday
//   node runReport.js 2026-08-04      -> that date
//   node runReport.js 2026-08-04 -c   -> also print it to the console

const Database = require("./src/database/Database");
const { printDailyReport, yesterdayISO } = require("./src/report");

(async () => {

    const args = process.argv.slice(2);
    const date = args.find(a => /^\d{4}-\d{2}-\d{2}$/.test(a)) || yesterdayISO();
    const toConsole = args.includes("-c") || args.includes("--console");

    const database = new Database();

    try {
        await database.initialize();
        await printDailyReport(database, date, { toConsole });

    } catch (err) {
        console.error("❌ Report failed:", err.message);

    } finally {
        await database.close().catch(() => {});
        process.exit(0);
    }

})();
