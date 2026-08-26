const Browser = require("./Browser");
const Sidebar = require("./Sidebar");
const Downloader = require("./Downloader1");
const Database = require("./database/Database");
const { printDailyReport } = require("./report");

class App {

    async run() {

        console.log(">>> LOADED:", __filename);

        console.log("==================================");
        console.log(" WhatsApp Payment Reader Started");
        console.log("==================================");

        this.database = new Database();
        await this.database.initialize();

        await this.database.query(
    "UPDATE report_params SET day = DATE('now','localtime','-1 day')"
).catch(() => {});

        const { page } = await Browser.startBrowser();

        // The cleanup must run even if a group throws halfway through,
        // otherwise Chromium keeps its lock on ./session and the NEXT run
        // cannot launch at all.
        try {

            const sidebar = new Sidebar(page);
            const downloader = new Downloader(page);

            // Replaces the old flat 15s wait: this blocks until the sidebar
            // has actually finished syncing, which is what matters on a cold
            // morning start.
            await sidebar.waitUntilReady();

            const totalSaved = await sidebar.processWatchlist(this.database, downloader);

            console.log(`Total images saved this run: ${totalSaved}`);

            // Summary for the day just scraped. Printed BEFORE the database is
            // closed, and lands in logs\run_YYYYMMDD.log with everything else.
            await printDailyReport(this.database).catch(err =>
                console.log(`⚠️ Could not print report: ${err.message}`)
            );

        } finally {

            await this.database.close().catch(err =>
                console.log(`⚠️ Error closing database: ${err.message}`)
            );

            // Only this — closeBrowser() owns the context and is safe to call
            // more than once. Calling context.close() as well just races it.
            await Browser.closeBrowser();

            console.log("Application Finished.");
        }

    }

}

module.exports = App;
