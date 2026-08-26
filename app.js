const App = require("./src/App");

const app = new App();

app.run().catch(err => {
    console.error("Fatal error:", err);
    process.exit(1);
});