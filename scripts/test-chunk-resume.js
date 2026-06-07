/**
 * Simulate refresh/resume: same sessionId, two inits → monotonic chunkIndex.
 * Usage: TEST_API_KEY=proj_xxx node scripts/test-chunk-resume.js
 */
require("dotenv").config({ path: require("path").join(__dirname, "../.env") });

const crypto = require("crypto");
const API = process.env.API_BASE || "http://127.0.0.1:3000";
const API_KEY = process.env.TEST_API_KEY || process.env.WT_TEST_API_KEY;
const RRWEB_FULL_SNAPSHOT = 2;

if (!API_KEY) {
  console.error("Set TEST_API_KEY or WT_TEST_API_KEY");
  process.exit(1);
}

const sessionId = crypto.randomUUID();
const segmentA = crypto.randomUUID();
const segmentB = crypto.randomUUID();

async function post(path, body) {
  const res = await fetch(`${API}/api${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

function fullSnapshotEvent() {
  return {
    type: RRWEB_FULL_SNAPSHOT,
    data: { node: { type: 0, childNodes: [] }, initialOffset: { top: 0, left: 0 } },
    timestamp: Date.now()
  };
}

async function main() {
  let failures = 0;

  const init1 = await post("/session/init", {
    apiKey: API_KEY,
    sessionId,
    url: "http://localhost:3000/demo-mp/",
    userAgent: "test-chunk-resume",
    viewport: { width: 1280, height: 720 }
  });
  if (!init1.data.success || init1.data.resumed || init1.data.nextChunkIndex !== 1) {
    console.error("First init failed", init1);
    failures++;
  } else {
    console.log("First init OK nextChunkIndex=1");
  }

  const chunk1 = await post("/session/rrweb-chunk", {
    apiKey: API_KEY,
    sessionId,
    chunkIndex: 1,
    segmentId: segmentA,
    isCheckout: true,
    recordedAt: Date.now(),
    events: [fullSnapshotEvent()]
  });
  if (chunk1.status !== 202) {
    console.error("Chunk 1 failed", chunk1);
    failures++;
  } else {
    console.log("Chunk 1 OK");
  }

  const init2 = await post("/session/init", {
    apiKey: API_KEY,
    sessionId,
    url: "http://localhost:3000/demo-mp/",
    userAgent: "test-chunk-resume",
    viewport: { width: 1280, height: 720 }
  });
  if (!init2.data.success || !init2.data.resumed || init2.data.nextChunkIndex !== 2) {
    console.error("Resume init expected nextChunkIndex=2", init2);
    failures++;
  } else {
    console.log("Resume init OK nextChunkIndex=2");
  }

  const chunk2 = await post("/session/rrweb-chunk", {
    apiKey: API_KEY,
    sessionId,
    chunkIndex: 2,
    segmentId: segmentB,
    isCheckout: true,
    recordedAt: Date.now(),
    events: [fullSnapshotEvent()]
  });
  if (chunk2.status !== 202) {
    console.error("Chunk 2 failed", chunk2);
    failures++;
  } else {
    console.log("Chunk 2 OK (no duplicate index collision)");
  }

  const dup = await post("/session/rrweb-chunk", {
    apiKey: API_KEY,
    sessionId,
    chunkIndex: 2,
    segmentId: segmentB,
    isCheckout: true,
    recordedAt: Date.now(),
    events: [{ type: 3, data: {}, timestamp: Date.now() }]
  });
  if (dup.status !== 409) {
    console.error("Expected 409 for conflicting chunkIndex=2", dup);
    failures++;
  } else {
    console.log("Duplicate chunk index correctly rejected (409)");
  }

  const Session = require("../modal/session");
  const Event = require("../modal/event");
  const connectDB = require("../utils/db");
  await connectDB();
  const session = await Session.findOne({ sessionId }).lean();
  const chunks = await Event.find({ sessionId: session._id, type: "rrweb_chunk" }).lean();
  if (chunks.length !== 2) {
    console.error(`Expected 2 chunk docs, got ${chunks.length}`);
    failures++;
  }

  await Event.deleteMany({ sessionId: session._id });
  await Session.deleteOne({ sessionId });
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
