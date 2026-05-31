const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const entry = path.join(root, "tracker-entry.js");
const outfile = path.join(root, "public", "tracker.bundle.js");

async function main() {
  fs.mkdirSync(path.dirname(outfile), { recursive: true });

  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    outfile,
    platform: "browser",
    target: "chrome80",
    minify: true,
    format: "iife",
  });

  const sizeKb = (fs.statSync(outfile).size / 1024).toFixed(1);
  console.log(`Built ${path.relative(root, outfile)} (${sizeKb} KB)`);
}

main().catch((err) => {
  console.error("Tracker build failed:", err.message);
  console.error(
    "If you see 'Exec format error', delete node_modules and run npm install on this server (do not copy node_modules from another machine)."
  );
  process.exit(1);
});
