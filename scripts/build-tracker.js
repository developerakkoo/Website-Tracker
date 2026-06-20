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
    banner: {
      js: `/* WT-TRACKER-BUILD: ${new Date().toISOString()} */`
    }
  });

  const sizeKb = (fs.statSync(outfile).size / 1024).toFixed(1);
  console.log(`Built ${path.relative(root, outfile)} (${sizeKb} KB)`);

  const metaPath = path.join(root, "public", "tracker-build-meta.json");
  fs.writeFileSync(
    metaPath,
    JSON.stringify(
      {
        version: "1.0.4",
        mode: "rrweb-default",
        builtAt: new Date().toISOString()
      },
      null,
      2
    ),
    "utf8"
  );
  console.log(`Wrote ${path.relative(root, metaPath)}`);
}

main().catch((err) => {
  console.error("Tracker build failed:", err.message);
  console.error(
    "If you see 'Exec format error', delete node_modules and run npm install on this server (do not copy node_modules from another machine)."
  );
  process.exit(1);
});
