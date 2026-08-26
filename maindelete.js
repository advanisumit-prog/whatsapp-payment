const Browser = require("./src/Browser");
const Sidebar = require("./src/Sidebar");
const Chat = require("./src/Chat");
const ImageFinder = require("./src/ImageFinder");
const Downloader = require("./src/Downloader");
const PaymentReader = require("./src/PaymentReader");
const Database = require("./src/database/Database");

(async () => {

    try {

        const { page } = await Browser.startBrowser();

        const sidebar = new Sidebar(page);
        const chat = new Chat(page);
        const imageFinder = new ImageFinder(page);
        const downloader = new Downloader(page);
        const reader = new PaymentReader();

const database = new Database();
await database.initialize();

      console.log("BEFORE SCAN");
      await sidebar.selectUnread();

const groups = await sidebar.scan();

console.log("AFTER SCAN");
console.log(groups.length);

      console.log("================================");
console.log("GROUPS RETURNED BY SIDEBAR");
console.log(JSON.stringify(
    groups.map(g => ({
        name: g.name,
        activityText: g.activityText
    })),
    null,
    2
));
console.log("================================");

        console.log(`\nFound ${groups.length} payment group(s)\n`);

        for (const group of groups) {

            await chat.open(group);

           const imageIndexes = await imageFinder.find();

console.log(`${group.name}: ${imageIndexes.length} image(s) found`);

for (const messageIndex of imageIndexes) {

    const message = page
        .locator('[data-testid="msg-container"]')
        .nth(messageIndex);

    await downloader.download(
        group.name,
        { locator: message },
        messageIndex
    );

}


            console.log();
        }

        console.log("Finished.");

    } catch (err) {

        console.error(err);

    }

})();