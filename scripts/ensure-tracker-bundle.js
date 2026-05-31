const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const bundlePath = path.join(__dirname, "..", "public", "tracker.bundle.js");

if (process.env.FORCE_TRACKER_BUILD === "1" || !fs.existsSync(bundlePath)) {
  execSync("node scripts/build-tracker.js", { stdio: "inherit" });
} else {
  console.log("Using existing public/tracker.bundle.js (set FORCE_TRACKER_BUILD=1 to rebuild)");
}
