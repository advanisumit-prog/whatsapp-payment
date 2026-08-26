// app.js  (project root)
//
// Entry point. Guarantees two things the scheduled task depends on:
//   1. the browser is closed, so ./session is not left locked
//   2. the process actually exits, so the task does not sit in "Running"

const App = require("./src/App");
const Browser = require("./src/Browser");

new App().run()
    .catch(err => {
        console.error("❌ Run failed:", err);
    })
    .finally(async () => {

        await Browser.closeBrowser();

        // Node stays alive while any handle is open — a stray timer or
        // listener is enough. Exit explicitly so the task completes.
        process.exit(0);
    });
