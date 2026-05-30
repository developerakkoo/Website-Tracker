/**
 * Smoke test for session replay pipeline (rrweb + snapshot capture).
 * Usage: node scripts/test-replay-e2e.js [apiBase] [apiKey]
 *
 * Requires API running and a valid project API key.
 */
const crypto = require("crypto");

const API_BASE = process.argv[2] || "http://localhost:3000";
const API_KEY = process.argv[3] || process.env.WT_TEST_API_KEY;

if (!API_KEY) {
  console.error("Provide API key: node scripts/test-replay-e2e.js http://localhost:3000 proj_xxx");
  process.exit(1);
}

const sessionId = crypto.randomUUID();

async function post(path, body) {
  const res = await fetch(`${API_BASE}/api${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

async function main() {
  console.log("Session replay E2E smoke test");
  console.log("  API:", API_BASE);
  console.log("  sessionId:", sessionId);

  const init = await post("/session/init", {
    apiKey: API_KEY,
    sessionId,
    url: "http://localhost:5500/",
    userAgent: "WT-E2E-Test",
    screen: { width: 1920, height: 1080 },
    viewport: { width: 1280, height: 720 }
  });
  if (!init.ok) {
    console.error("FAIL init", init.status, init.data);
    process.exit(1);
  }
  console.log("OK  session/init");

  const fakeSnapshot = "<html><head><title>E2E</title></head><body><h1>Test</h1></body></html>";
  const capture = await post("/session/capture", {
    apiKey: API_KEY,
    sessionId,
    snapshot: fakeSnapshot
  });
  if (!capture.ok || !capture.data.ok) {
    console.error("FAIL capture", capture.status, capture.data);
    process.exit(1);
  }
  console.log("OK  session/capture bytes=", capture.data.bytes);

  const rrwebChunk = await post("/session/rrweb-chunk", {
    apiKey: API_KEY,
    sessionId,
    chunkIndex: 1,
    isCheckout: true,
    recordedAt: Date.now(),
    events: [
      { type: 4, data: { href: "http://localhost:5500/" }, timestamp: Date.now() },
      {
        type: 2,
        data: { node: { type: 0, childNodes: [] }, initialOffset: { top: 0, left: 0 } },
        timestamp: Date.now() + 1
      }
    ]
  });
  if (!rrwebChunk.ok) {
    console.error("FAIL rrweb-chunk", rrwebChunk.status, rrwebChunk.data);
    process.exit(1);
  }
  console.log("OK  session/rrweb-chunk");

  const events = await post("/session/events", {
    apiKey: API_KEY,
    sessionId,
    events: [{ type: "click", data: { x: 10, y: 10 }, timestamp: Date.now(), pageIndex: 0 }]
  });
  if (!events.ok) {
    console.error("FAIL events", events.status, events.data);
    process.exit(1);
  }
  console.log("OK  session/events");

  console.log("\nAll ingestion checks passed.");
  console.log("Open the dashboard replay page for session:", sessionId);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
