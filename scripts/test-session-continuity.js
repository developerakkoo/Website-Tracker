/**
 * Integration test: multi-page session continuity via /api/session/init resume.
 * Requires API running on PORT (default 3000) and valid TEST_API_KEY in env.
 *
 * Usage: TEST_API_KEY=proj_xxx node scripts/test-session-continuity.js
 */
require("dotenv").config({ path: require("path").join(__dirname, "../.env") });

const API = process.env.API_BASE || "http://127.0.0.1:3000";
const API_KEY = process.env.TEST_API_KEY;

if (!API_KEY) {
  console.error("Set TEST_API_KEY to a valid project apiKey (proj_…)");
  process.exit(1);
}

const sessionId = "test-mp-" + Date.now();
const pages = [
  "http://localhost:3000/demo-mp/",
  "http://localhost:3000/demo-mp/about.html",
  "http://localhost:3000/demo-mp/contact.html",
  "http://localhost:3000/demo-mp/pricing.html",
];

async function post(path, body) {
  const res = await fetch(`${API}/api${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function sendEvents(pageIndex) {
  return post("/session/events", {
    apiKey: API_KEY,
    sessionId,
    events: [
      {
        type: "click",
        data: { x: 100, y: 200 },
        timestamp: Date.now(),
        pageIndex,
      },
    ],
  });
}

async function main() {
  let failures = 0;

  for (let i = 0; i < pages.length; i++) {
    const url = pages[i];
    const init = await post("/session/init", {
      apiKey: API_KEY,
      sessionId,
      url,
      userAgent: "test-session-continuity",
      viewport: { width: 1280, height: 720 },
    });

    if (i === 0) {
      if (!init.data.success || init.data.resumed) {
        console.error("Page 1: expected new session", init);
        failures++;
      } else {
        console.log("Page 1: new session OK");
      }
    } else {
      if (!init.data.resumed || init.data.pageIndex !== i) {
        console.error(`Page ${i + 1}: expected resume pageIndex ${i}`, init);
        failures++;
      } else {
        console.log(`Page ${i + 1}: resumed at pageIndex ${init.data.pageIndex} OK`);
      }
    }

    const ev = await sendEvents(init.data.pageIndex ?? i);
    if (ev.status !== 200) {
      console.error(`Page ${i + 1}: events failed`, ev);
      failures++;
    }
  }

  const Session = require("../modal/session");
  const connectDB = require("../utils/db");
  await connectDB();
  const doc = await Session.findOne({ sessionId }).lean();
  const pageCount = doc?.pages?.length || 0;

  if (pageCount !== 4) {
    console.error(`Expected 1 session with 4 pages, got pages.length=${pageCount}`);
    failures++;
  } else {
    console.log("MongoDB: single session with 4 pages OK");
  }

  await Session.deleteOne({ sessionId });
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
