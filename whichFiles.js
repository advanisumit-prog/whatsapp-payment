// whichFiles.js — run with:  node whichFiles.js
// Follows require() calls from the entry point and prints the files that are
// actually part of your app, plus any project .js files that are NOT.

const fs = require("fs");
const path = require("path");

const ENTRY = process.argv[2] || "./src/App.js";
const ROOT = process.cwd();

const visited = new Set();
const missing = [];

function resolveRelative(fromFile, spec) {
    const base = path.resolve(path.dirname(fromFile), spec);
    const candidates = [base, base + ".js", base + ".json", path.join(base, "index.js")];
    for (const c of candidates) {
        if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
    }
    return null;
}

function walk(file, depth, viaSpec) {

    const rel = path.relative(ROOT, file);

    if (visited.has(file)) {
        console.log(`${"  ".repeat(depth)}↳ ${rel}  (already loaded)`);
        return;
    }
    visited.add(file);

    console.log(`${"  ".repeat(depth)}↳ ${rel}${viaSpec ? `   [require("${viaSpec}")]` : ""}`);

    let src;
    try {
        src = fs.readFileSync(file, "utf8");
    } catch (err) {
        return;
    }

    const specs = [...src.matchAll(/require\(\s*["'](\.[^"']+)["']\s*\)/g)].map(m => m[1]);

    for (const spec of specs) {
        const target = resolveRelative(file, spec);
        if (target) {
            walk(target, depth + 1, spec);
        } else {
            missing.push({ from: rel, spec });
        }
    }
}

const entryPath = path.resolve(ROOT, ENTRY);

if (!fs.existsSync(entryPath)) {
    console.log(`❌ Entry file not found: ${entryPath}`);
    console.log(`   Usage: node whichFiles.js ./src/App.js`);
    process.exit(1);
}

console.log(`\n=== FILES ACTUALLY USED (from ${ENTRY}) ===\n`);
walk(entryPath, 0, null);

if (missing.length) {
    console.log(`\n=== UNRESOLVED REQUIRES ===`);
    missing.forEach(m => console.log(`  ${m.from}  ->  require("${m.spec}")  NOT FOUND`));
}

// Any project .js file never reached from the entry point is dead weight.
const allFiles = [];

(function scan(dir) {
    for (const name of fs.readdirSync(dir)) {
        if (["node_modules", ".git", "session", "downloads", "database", "logs"].includes(name)) continue;
        const full = path.join(dir, name);
        const stat = fs.statSync(full);
        if (stat.isDirectory()) scan(full);
        else if (name.endsWith(".js")) allFiles.push(full);
    }
})(ROOT);

const unused = allFiles
    .filter(f => !visited.has(f))
    .filter(f => path.basename(f) !== path.basename(__filename));

console.log(`\n=== PROJECT .js FILES NOT USED (${unused.length}) ===\n`);
unused.forEach(f => console.log(`  ${path.relative(ROOT, f)}`));

console.log(`\nLoaded: ${visited.size} file(s).  Unused: ${unused.length} file(s).\n`);
