/**
 * Two distinct sessionIds → two MongoDB session documents.
 * Usage: TEST_API_KEY=proj_xxx node scripts/test-session-per-tab.js
 */
require("dotenv").config({ path: require("path").join(__dirname, "../.env") });

const crypto = require("crypto");
const API = process.env.API_BASE || "http://127.0.0.1:3000";
const API_KEY = process.env.TEST_API_KEY || process.env.WT_TEST_API_KEY;

if (!API_KEY) {
  console.error("Set TEST_API_KEY or WT_TEST_API_KEY");
  process.exit(1);
}

async function post(path, body) {
  const res = await fetch(`${API}/api${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function main() {
  const sidA = crypto.randomUUID();
  const sidB = crypto.randomUUID();
  let failures = 0;

  for (const [label, sid] of [
    ["Tab A", sidA],
    ["Tab B", sidB]
  ]) {
    const init = await post("/session/init", {
      apiKey: API_KEY,
      sessionId: sid,
      url: "http://localhost:3000/demo-mp/",
      userAgent: "test-per-tab",
      viewport: { width: 1280, height: 720 }
    });
    if (!init.data.success || init.data.resumed) {
      console.error(`${label}: expected new session`, init);
      failures++;
    } else if (init.data.nextChunkIndex !== 1) {
      console.error(`${label}: expected nextChunkIndex=1`, init.data);
      failures++;
    } else {
      console.log(`${label}: new session OK (${sid.slice(0, 8)}…)`);
    }
  }

  const connectDB = require("../utils/db");
  const Session = require("../modal/session");
  await connectDB();

  const count = await Session.countDocuments({ sessionId: { $in: [sidA, sidB] } });
  if (count !== 2) {
    console.error(`Expected 2 sessions in DB, got ${count}`);
    failures++;
  } else {
    console.log("MongoDB: 2 distinct sessions OK");
  }

  await Session.deleteMany({ sessionId: { $in: [sidA, sidB] } });
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
