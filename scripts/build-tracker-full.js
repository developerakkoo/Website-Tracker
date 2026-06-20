const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const root = path.join(__dirname, "..");
const bundlePath = path.join(root, "public", "tracker.bundle.js");
const outPath = path.join(root, "public", "tracker.js");
const builderPath = path.join(root, "utils", "snapshotBuilder.js");

if (!fs.existsSync(bundlePath)) {
  execSync("node scripts/build-tracker.js", { stdio: "inherit", cwd: root });
}

const builder = fs.readFileSync(builderPath, "utf8");
const bundle = fs.readFileSync(bundlePath, "utf8");
fs.writeFileSync(outPath, builder + "\n" + bundle, "utf8");

const sizeKb = (fs.statSync(outPath).size / 1024).toFixed(1);
console.log(`Built ${path.relative(root, outPath)} (${sizeKb} KB)`);
