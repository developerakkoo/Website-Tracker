const express = require("express");
const crypto = require("crypto");
const zlib = require("zlib");
const { promisify } = require("util");
const Session = require("../modal/session");
const Project = require("../modal/project");
const Event = require("../modal/event");
const authMiddleware = require("../middleware/authMiddleware");
const heatmapAggregator = require("../utils/heatmapAggregator");
const goalClickAggregator = require("../utils/goalClickAggregator");
const { normalizeSnapshot } = require("../utils/snapshotSanitizer");
const {
  mirrorAsset,
  getMirroredAsset,
  extractFontUrlsFromCss
} = require("../utils/assetMirror");
const { isMongoStorageQuotaError, storageQuotaResponse } = require("../utils/mongoStorageError");

const router = express.Router();

const gunzip = promisify(zlib.gunzip);

const SESSION_TTL_MS = 30 * 60 * 1000;
const RRWEB_FULL_SNAPSHOT_TYPE = 2;

async function decodeGzipJsonBody(body) {
  const compressed = Buffer.from(body, "base64");
  const decompressed = await gunzip(compressed);
  return JSON.parse(decompressed.toString("utf8"));
}

async function extractSnapshotFromCaptureBody(body) {
  const { snapshot, body: encodedBody, encoding } = body;
  if (encoding === "gzip" && encodedBody) {
    const parsed = await decodeGzipJsonBody(encodedBody);
    return typeof parsed === "string" ? parsed : parsed.snapshot || "";
  }
  return snapshot || "";
}

function chunkHasFullSnapshot(eventsArray) {
  return eventsArray.some((ev) => ev && ev.type === RRWEB_FULL_SNAPSHOT_TYPE);
}

function deriveRrwebStatus(existingStatus, eventsArray, isCheckout, sessionHasFullSnapshot) {
  const hasFs = chunkHasFullSnapshot(eventsArray);
  const anyFs = hasFs || !!sessionHasFullSnapshot;
  if (isCheckout && anyFs) return "complete";
  if (hasFs) return existingStatus === "complete" ? "complete" : "partial";
  if (existingStatus === "none" && eventsArray.length > 0) return "partial";
  return existingStatus || "none";
}

function sessionHasRecording(session) {
  if (session.eventCount > 0) return true;
  if (session.hasRrweb || (session.rrwebChunkCount && session.rrwebChunkCount > 0)) return true;
  if (typeof session.snapshot === "string" && session.snapshot.trim().length > 0) return true;
  if (Array.isArray(session.pages)) {
    return session.pages.some((p) => typeof p.snapshot === "string" && p.snapshot.trim().length > 0);
  }
  return false;
}

async function getChunkCursor(sessionDoc) {
  const maxChunk = await Event.findOne(
    { sessionId: sessionDoc._id, type: "rrweb_chunk" },
    { "data.chunkIndex": 1 }
  )
    .sort({ "data.chunkIndex": -1 })
    .lean();
  const nextChunkIndex = (maxChunk?.data?.chunkIndex || 0) + 1;
  const rrwebChunkCount =
    typeof sessionDoc.rrwebChunkCount === "number"
      ? sessionDoc.rrwebChunkCount
      : await Event.countDocuments({ sessionId: sessionDoc._id, type: "rrweb_chunk" });
  return { nextChunkIndex, rrwebChunkCount };
}

function buildInitPayload(base, sessionDoc) {
  return {
    ...base,
    nextChunkIndex: 1,
    rrwebChunkCount: 0,
    recordingHealth: sessionDoc?.recordingHealth || {
      hasFullSnapshot: false,
      chunkCount: 0,
      failedChunks: 0
    }
  };
}

async function buildResumeInitPayload(base, sessionDoc) {
  const cursor = await getChunkCursor(sessionDoc);
  return {
    ...base,
    nextChunkIndex: cursor.nextChunkIndex,
    rrwebChunkCount: cursor.rrwebChunkCount,
    recordingHealth: sessionDoc.recordingHealth || {
      hasFullSnapshot: false,
      chunkCount: cursor.rrwebChunkCount,
      failedChunks: 0
    }
  };
}

function hashEventsArray(eventsArray) {
  return crypto.createHash("sha256").update(JSON.stringify(eventsArray)).digest("hex");
}

function deriveDeviceType(userAgent) {
  if (!userAgent || typeof userAgent !== "string") return "desktop";
  const ua = userAgent.toLowerCase();
  if (/android/.test(ua)) return "android";
  if (/iphone|ipad|ipod/.test(ua)) return "ios";
  if (/tablet|ipad/.test(ua)) return "tablet";
  return "desktop";
}

function isSessionExpired(session) {
  const lastAct = session.lastActivity || session.startedAt;
  if (!lastAct) return false;
  return Date.now() - new Date(lastAct).getTime() > SESSION_TTL_MS;
}

async function appendPageToSession(session, url, viewport) {
  const vp =
    viewport && typeof viewport.width === "number" && typeof viewport.height === "number"
      ? viewport
      : session.viewport;
  const startedAt = new Date();

  await Session.findByIdAndUpdate(session._id, {
    $push: {
      pages: {
        url,
        snapshot: "",
        startedAt,
        viewport: vp,
        eventsCount: 0,
        baseUrl: url
      }
    },
    $set: { url, lastActivity: new Date(), viewport: vp || session.viewport }
  });

  const updated = await Session.findById(session._id).lean();
  const pageIndex = Math.max(0, (updated.pages?.length || 1) - 1);
  return pageIndex;
}

// Initialize Session (POST /api/session/init)
router.post("/session/init", async (req, res) => {
  try {
  const { apiKey, sessionId, url, userAgent, screen, viewport } = req.body;

  if (!apiKey || !sessionId) {
    return res.status(400).json({ message: "Missing required fields" });
  }

  const project = await Project.findOne({ apiKey });
  if (!project) {
    return res.status(403).json({ message: "Invalid API key" });
  }

  const existing = await Session.findOne({ sessionId });
  if (existing) {
    if (existing.projectId.toString() !== project._id.toString()) {
      return res.status(403).json({ message: "Invalid session for project" });
    }
    if (isSessionExpired(existing)) {
      return res.status(410).json({ expired: true, message: "Session expired" });
    }

    const pages = existing.pages || [];
    const lastPage = pages.length > 0 ? pages[pages.length - 1] : null;
    if (lastPage && lastPage.url === url) {
      await Session.findByIdAndUpdate(existing._id, {
        $set: { url, lastActivity: new Date() }
      });
      const payload = await buildResumeInitPayload(
        {
          success: true,
          resumed: true,
          pageIndex: pages.length - 1,
          newPage: false,
          sessionId
        },
        existing
      );
      return res.json(payload);
    }

    const pageIndex = await appendPageToSession(existing, url, viewport);
    const payload = await buildResumeInitPayload(
      {
        success: true,
        resumed: true,
        pageIndex,
        newPage: true,
        sessionId
      },
      existing
    );
    return res.json(payload);
  }

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayCount = await Session.countDocuments({
    projectId: project._id,
    startedAt: { $gte: todayStart }
  });
  const DAILY_QUOTA = project.dailySessionQuota || 10000;
  if (todayCount >= DAILY_QUOTA) {
    return res.status(429).json({ error: "quota_exceeded", limit: DAILY_QUOTA });
  }

  const deviceType = deriveDeviceType(userAgent);
  const vp =
    viewport && typeof viewport.width === "number" && typeof viewport.height === "number"
      ? viewport
      : undefined;
  const startedAt = new Date();

  await Session.create({
    projectId: project._id,
    sessionId,
    url,
    userAgent,
    screen,
    viewport: vp,
    deviceType,
    ipAddress: req.ip,
    startedAt,
    lastActivity: new Date(),
    recordingHealth: { hasFullSnapshot: false, chunkCount: 0, failedChunks: 0 },
    pages: [
      {
        url: url || "",
        snapshot: "",
        startedAt,
        viewport: vp,
        eventsCount: 0,
        baseUrl: url || ""
      }
    ]
  });

  res.json(
    buildInitPayload(
      {
        success: true,
        resumed: false,
        pageIndex: 0,
        newPage: true,
        sessionId
      },
      null
    )
  );
  } catch (err) {
    if (isMongoStorageQuotaError(err)) {
      console.error("session/init storage quota:", err.message || err);
      return storageQuotaResponse(res);
    }
    console.error("session/init error:", err.message || err);
    return res.status(500).json({ ok: false, code: "server_error", message: "Internal server error" });
  }
});

// New page in session (SPA / navigation) — POST /api/session/page
router.post("/session/page", async (req, res) => {
  const { apiKey, sessionId, url, timestamp, viewport } = req.body;
  if (!apiKey || !sessionId || !url) {
    return res.status(400).json({ message: "Missing required fields" });
  }
  const project = await Project.findOne({ apiKey });
  if (!project) return res.status(403).json({ message: "Invalid API key" });
  const session = await Session.findOne({ sessionId });
  if (!session) return res.status(404).json({ message: "Session not found" });
  if (isSessionExpired(session)) {
    return res.status(410).json({ expired: true, message: "Session expired" });
  }

  const vp =
    viewport && typeof viewport.width === "number" && typeof viewport.height === "number"
      ? viewport
      : session.viewport;
  const startedAt = timestamp ? new Date(timestamp) : new Date();

  await Session.findByIdAndUpdate(session._id, {
    $push: {
      pages: {
        url,
        snapshot: "",
        startedAt,
        viewport: vp,
        eventsCount: 0,
        baseUrl: url
      }
    },
    $set: { url, lastActivity: new Date(), viewport: vp || session.viewport }
  });

  const updated = await Session.findById(session._id).lean();
  const pageIndex = Math.max(0, (updated.pages?.length || 1) - 1);
  res.json({ success: true, pageIndex });
});

// Mirror remote asset for replay — POST /api/session/mirror-asset
router.post("/session/mirror-asset", async (req, res) => {
  try {
    const { apiKey, sessionId, url } = req.body;
    if (!apiKey || !sessionId || !url) {
      return res.status(400).json({ ok: false, code: "missing_fields" });
    }
    const project = await Project.findOne({ apiKey });
    if (!project) return res.status(403).json({ ok: false, code: "invalid_key" });
    const session = await Session.findOne({ sessionId, projectId: project._id });
    if (!session) return res.status(404).json({ ok: false, code: "session_not_found" });

    const result = await mirrorAsset(String(url));
    const mirrorUrl = `/api/mirror/${result.hash}`;

    if (result.contentType && String(result.contentType).includes("text/css")) {
      const asset = getMirroredAsset(result.hash);
      if (asset?.buffer) {
        const fontUrls = extractFontUrlsFromCss(asset.buffer.toString("utf8"), String(url));
        fontUrls.slice(0, 15).forEach((fontUrl) => {
          mirrorAsset(fontUrl).catch(() => {});
        });
      }
    }

    return res.json({ ok: true, hash: result.hash, mirrorUrl, cached: result.cached });
  } catch (err) {
    console.error("mirror-asset error:", err.message);
    return res.status(422).json({ ok: false, code: "mirror_failed", message: err.message });
  }
});

// Serve mirrored asset — GET /api/mirror/:hash
router.get("/mirror/:hash", (req, res) => {
  const asset = getMirroredAsset(req.params.hash);
  if (!asset) return res.status(404).send("Not found");
  res.setHeader("Content-Type", asset.contentType);
  res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  res.setHeader("Access-Control-Allow-Origin", "*");
  return res.send(asset.buffer);
});

// Save snapshot — POST /api/session/capture (latest page + legacy snapshot field)
router.post("/session/capture", async (req, res) => {
  try {
    const { apiKey, sessionId } = req.body;
    if (!apiKey || !sessionId) {
      return res.status(400).json({ ok: false, code: "missing_fields", message: "Missing required fields" });
    }
    const project = await Project.findOne({ apiKey });
    if (!project) {
      return res.status(403).json({ ok: false, code: "invalid_key", message: "Invalid API key" });
    }
    const session = await Session.findOne({ sessionId });
    if (!session) {
      return res.status(404).json({ ok: false, code: "session_not_found", message: "Session not found" });
    }

    let rawSnapshot;
    try {
      rawSnapshot = await extractSnapshotFromCaptureBody(req.body);
    } catch (decodeErr) {
      console.error("Capture decode error:", decodeErr.message);
      return res.status(400).json({ ok: false, code: "decode_error", message: "Could not decode snapshot payload" });
    }

    const rawBytes = Buffer.byteLength(rawSnapshot || "", "utf8");
    if (!rawSnapshot || rawBytes === 0) {
      return res.status(400).json({ ok: false, code: "empty_snapshot", message: "Snapshot is empty" });
    }

    const snapBeforeNorm = rawSnapshot;
    const snap = normalizeSnapshot(rawSnapshot);
    const truncated = snap.length < snapBeforeNorm.length;
    const snapBytes = Buffer.byteLength(snap, "utf8");
    const capturedAt = new Date();

    const so = session.toObject();
    let pages = Array.isArray(so.pages) ? so.pages.map((p) => ({ ...p })) : [];
    if (pages.length === 0) {
      pages.push({
        url: session.url || "",
        snapshot: snap,
        startedAt: session.startedAt,
        viewport: session.viewport,
        eventsCount: 0,
        snapshotBytes: snapBytes,
        snapshotCapturedAt: capturedAt
      });
    } else {
      const lastIdx = pages.length - 1;
      const existing = pages[lastIdx];
      const existingBytes = existing.snapshotBytes || (existing.snapshot ? existing.snapshot.length : 0);
      if (snapBytes >= existingBytes || !existing.snapshot) {
        pages[lastIdx] = {
          ...existing,
          snapshot: snap,
          snapshotBytes: snapBytes,
          snapshotCapturedAt: capturedAt
        };
      } else {
        return res.json({
          ok: true,
          skipped: true,
          reason: "existing_snapshot_larger",
          bytes: existingBytes
        });
      }
    }

    await Session.findByIdAndUpdate(session._id, { $set: { snapshot: snap, pages } });

    console.info(
      `[capture] session=${sessionId} bytes=${snapBytes} truncated=${truncated} pages=${pages.length}`
    );

    return res.json({
      ok: true,
      success: true,
      bytes: snapBytes,
      truncated
    });
  } catch (err) {
    if (isMongoStorageQuotaError(err)) {
      console.error("Capture storage quota:", err.message || err);
      return storageQuotaResponse(res);
    }
    if (err.type === "entity.too.large") {
      return res.status(413).json({ ok: false, code: "payload_too_large", message: "Snapshot payload too large" });
    }
    console.error("Capture error:", err);
    return res.status(500).json({ ok: false, code: "server_error", message: "Internal server error" });
  }
});

async function getSessionForUser(sessionIdStr, userId) {
  const session = await Session.findOne({ sessionId: sessionIdStr }).populate("projectId");
  if (!session || !session.projectId) return null;
  if (session.projectId.userId.toString() !== userId) return null;
  return session;
}

// Full multi-page replay payload — GET /api/session/:sessionId/full
router.get("/session/:sessionId/full", authMiddleware, async (req, res) => {
  const session = await getSessionForUser(req.params.sessionId, req.user.id);
  if (!session) {
    return res.status(404).json({ message: "Session not found" });
  }
  if (!sessionHasRecording(session)) {
    return res.status(404).json({ message: "This visit has no recording to play" });
  }

  const allEvents = await Event.find({
    sessionId: session._id,
    type: { $nin: ["rrweb_chunk", "note"] }
  })
    .sort({ timestamp: 1 })
    .lean();
  const mapEv = (e) => ({
    type: e.type,
    data: e.data,
    timestamp: e.timestamp,
    pageIndex: e.pageIndex != null ? e.pageIndex : 0
  });

  let pagesOut = [];
  if (session.pages && session.pages.length > 0) {
    const sorted = [...session.pages].sort(
      (a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime()
    );
    pagesOut = sorted.map((p, idx) => ({
      url: p.url,
      snapshot: p.snapshot || "",
      startedAt: p.startedAt,
      viewport: p.viewport,
      events: allEvents.filter((e) => (e.pageIndex != null ? e.pageIndex : 0) === idx).map(mapEv)
    }));
  } else {
    pagesOut = [
      {
        url: session.url,
        snapshot: session.snapshot || "",
        startedAt: session.startedAt,
        viewport: session.viewport,
        events: allEvents.map(mapEv)
      }
    ];
  }

  const times = allEvents.map((e) => e.timestamp);
  const totalDuration =
    times.length > 1 ? Math.max(...times) - Math.min(...times) : session.duration || 0;

  return res.json({
    pages: pagesOut,
    totalDuration,
    deviceType: session.deviceType,
    sessionViewport: session.viewport,
    startedAt: session.startedAt
  });
});

// Get session events (protected; for replay) — GET /api/session/:sessionId/events
router.get("/session/:sessionId/events", authMiddleware, async (req, res) => {
  const session = await getSessionForUser(req.params.sessionId, req.user.id);
  if (!session) {
    return res.status(404).json({ message: "Session not found" });
  }
  if (!sessionHasRecording(session)) {
    return res.status(404).json({ message: "This visit has no recording to play" });
  }
  const events = await Event.find({
    sessionId: session._id,
    type: { $nin: ["rrweb_chunk", "note"] }
  }).sort({ timestamp: 1 });
  return res.json(
    events.map((e) => ({
      type: e.type,
      data: e.data,
      timestamp: e.timestamp,
      pageIndex: e.pageIndex != null ? e.pageIndex : 0
    }))
  );
});

// Get session (protected; for replay) — GET /api/session/:sessionId
router.get("/session/:sessionId", authMiddleware, async (req, res) => {
  const session = await getSessionForUser(req.params.sessionId, req.user.id);
  if (!session) {
    return res.status(404).json({ message: "Session not found" });
  }
  return res.json({
    snapshot: session.snapshot,
    startedAt: session.startedAt,
    duration: session.duration,
    eventCount: session.eventCount,
    screen: session.screen,
    userAgent: session.userAgent,
    viewport: session.viewport,
    deviceType: session.deviceType,
    pages: session.pages || [],
    hasRrweb: !!session.hasRrweb,
    rrwebStatus: session.rrwebStatus || "none",
    rrwebChunkCount: session.rrwebChunkCount || 0,
    recordingHealth: session.recordingHealth || {
      hasFullSnapshot: false,
      chunkCount: session.rrwebChunkCount || 0,
      failedChunks: 0
    },
    rageClickCount: session.rageClickCount || 0,
    deadClickCount: session.deadClickCount || 0,
    errorCount: session.errorCount || 0,
    networkErrorCount: session.networkErrorCount || 0,
    starred: !!session.starred,
    tags: session.tags || []
  });
});

// Track Events — POST /api/session/events
router.post("/session/events", async (req, res) => {
  const { apiKey, sessionId, events } = req.body;

  if (!apiKey || !sessionId || !Array.isArray(events)) {
    return res.status(400).json({ message: "Invalid payload" });
  }

  if (events.length === 0) {
    return res.json({ success: true });
  }

  const project = await Project.findOne({ apiKey });
  if (!project) {
    return res.status(403).json({ message: "Invalid API key" });
  }

  const session = await Session.findOne({ sessionId });
  if (!session) {
    return res.status(404).json({ message: "Session not found" });
  }

  const hasPages = session.pages && session.pages.length > 0;
  const pageLen = hasPages ? session.pages.length : 1;

  const formattedEvents = events.map((e) => {
    let pi = typeof e.pageIndex === "number" ? e.pageIndex : 0;
    if (pi < 0) pi = 0;
    if (pi >= pageLen) pi = pageLen - 1;
    return {
      sessionId: session._id,
      type: e.type,
      data: e.data,
      timestamp: e.timestamp,
      pageIndex: pi
    };
  });

  await Event.insertMany(formattedEvents);

  let rageInc = 0;
  let deadInc = 0;
  let errorInc = 0;
  let networkErrorInc = 0;
  events.forEach((event) => {
    if (event.type === "rage_click") rageInc++;
    if (event.type === "dead_click") deadInc++;
    if (event.type === "console" && event.data?.level === "error") errorInc++;
    if (event.type === "network" && event.data?.error) networkErrorInc++;
  });

  const incUpdate = {
    eventCount: events.length,
    rageClickCount: rageInc,
    deadClickCount: deadInc,
    errorCount: errorInc,
    networkErrorCount: networkErrorInc
  };
  if (hasPages) {
    const pageIncs = {};
    formattedEvents.forEach((fe) => {
      const pi = fe.pageIndex;
      pageIncs[pi] = (pageIncs[pi] || 0) + 1;
    });
    Object.keys(pageIncs).forEach((pi) => {
      incUpdate[`pages.${pi}.eventsCount`] = pageIncs[pi];
    });
  }

  await Session.findByIdAndUpdate(session._id, {
    $inc: incUpdate,
    $set: { lastActivity: new Date(), duration: Date.now() - session.startedAt }
  });

  heatmapAggregator.addEvents(
    session.projectId,
    session.url || "",
    session.deviceType,
    session.viewport,
    events.filter((e) => e.type === "click" || e.type === "scroll" || e.type === "mousemove")
  );

  const goalEvents = events.filter((e) => e.type === "goal_click" && e.data?.goalKey);
  if (goalEvents.length > 0) {
    const enabledKeys = await goalClickAggregator.loadEnabledGoalKeys(project._id);
    goalClickAggregator.addGoalClicks(project._id, session._id, goalEvents, enabledKeys);
  }

  res.json({ success: true });
});

// POST /api/session/end — finalize session on tab close (optional beacon)
router.post("/session/end", async (req, res) => {
  try {
    const { apiKey, sessionId } = req.body;
    if (!apiKey || !sessionId) {
      return res.status(400).json({ ok: false, code: "missing_fields" });
    }
    const project = await Project.findOne({ apiKey });
    if (!project) return res.status(403).json({ ok: false, code: "invalid_key" });
    const session = await Session.findOne({ sessionId, projectId: project._id });
    if (!session) return res.status(404).json({ ok: false, code: "session_not_found" });

    const now = new Date();
    await Session.updateOne(
      { _id: session._id },
      {
        $set: {
          lastActivity: now,
          duration: now.getTime() - session.startedAt.getTime()
        }
      }
    );
    return res.json({ ok: true });
  } catch (err) {
    console.error("session/end error:", err.message);
    return res.status(500).json({ ok: false, code: "server_error" });
  }
});

// POST /api/session/recording-status — upload health from tracker on unload
router.post("/session/recording-status", async (req, res) => {
  try {
    const { apiKey, sessionId, chunksOk, chunksFailed } = req.body;
    if (!apiKey || !sessionId) {
      return res.status(400).json({ ok: false, code: "missing_fields" });
    }
    const project = await Project.findOne({ apiKey });
    if (!project) return res.status(403).json({ ok: false, code: "invalid_key" });
    const session = await Session.findOne({ sessionId, projectId: project._id });
    if (!session) return res.status(404).json({ ok: false, code: "session_not_found" });

    const inc = {};
    if (chunksFailed > 0) {
      inc["recordingHealth.failedChunks"] = Number(chunksFailed) || 0;
    }
    const update = {
      $set: { "recordingHealth.lastChunkAt": new Date() }
    };
    if (Object.keys(inc).length > 0) update.$inc = inc;

    await Session.updateOne({ _id: session._id }, update);
    return res.json({ ok: true, chunksOk: chunksOk || 0 });
  } catch (err) {
    console.error("recording-status error:", err.message);
    return res.status(500).json({ ok: false, code: "server_error" });
  }
});

// POST /api/session/rrweb-chunk — rrweb event chunks from upgraded tracker
router.post("/session/rrweb-chunk", async (req, res) => {
  const startedAt = Date.now();
  try {
    const {
      apiKey,
      sessionId,
      chunkIndex,
      segmentId,
      isCheckout,
      recordedAt,
      events,
      body,
      encoding
    } = req.body;
    if (!apiKey || !sessionId) {
      return res.status(400).json({ error: "missing fields" });
    }

    const project = await Project.findOne({ apiKey });
    if (!project) return res.status(401).json({ error: "invalid key" });

    const session = await Session.findOne({ sessionId, projectId: project._id });
    if (!session) return res.status(404).json({ error: "session not found" });

    let eventsArray;
    if (encoding === "gzip" && body) {
      const compressed = Buffer.from(body, "base64");
      const decompressed = await gunzip(compressed);
      const parsed = JSON.parse(decompressed.toString("utf8"));
      eventsArray = parsed.events || parsed;
    } else if (Array.isArray(events)) {
      eventsArray = events;
    } else if (body && encoding === "identity") {
      const parsed = typeof body === "string" ? JSON.parse(body) : body;
      eventsArray = parsed.events || parsed;
    } else {
      eventsArray = [];
    }

    if (!Array.isArray(eventsArray)) {
      return res.status(400).json({ error: "invalid events" });
    }

    const approxBytes = JSON.stringify(eventsArray).length;
    if (approxBytes > 15 * 1024 * 1024) {
      return res.status(413).json({ ok: false, code: "chunk_too_large", message: "Chunk exceeds size limit" });
    }

    const idx = chunkIndex || 0;
    const existingChunk = await Event.findOne({
      sessionId: session._id,
      type: "rrweb_chunk",
      "data.chunkIndex": idx
    }).lean();

    if (existingChunk) {
      const existingHash = hashEventsArray(existingChunk.data?.events || []);
      const newHash = hashEventsArray(eventsArray);
      if (existingHash === newHash) {
        return res.status(202).json({ ok: true, duplicate: true });
      }
      return res.status(409).json({
        ok: false,
        code: "duplicate_chunk_index",
        message: "Chunk index already used with different payload"
      });
    }

    const chunkDoc = {
      sessionId: session._id,
      type: "rrweb_chunk",
      data: {
        chunkIndex: idx,
        segmentId: segmentId || null,
        isCheckout: !!isCheckout,
        events: eventsArray
      },
      timestamp: recordedAt || Date.now(),
      pageIndex: 0
    };

    await Event.create(chunkDoc);

    const hasFs = chunkHasFullSnapshot(eventsArray);
    const prevHasFs = !!(session.recordingHealth && session.recordingHealth.hasFullSnapshot);
    const rrwebStatus = deriveRrwebStatus(session.rrwebStatus, eventsArray, !!isCheckout, prevHasFs || hasFs);

    if (idx === 1 && !hasFs) {
      console.warn(
        `[rrweb-chunk] session=${sessionId} first chunk missing full snapshot (${eventsArray.length} events, ~${approxBytes} bytes)`
      );
    }

    const newChunkCount = (session.rrwebChunkCount || 0) + 1;
    await Session.updateOne(
      { _id: session._id },
      {
        $inc: { eventCount: eventsArray.length, rrwebChunkCount: 1 },
        $set: {
          lastActivity: new Date(),
          hasRrweb: true,
          rrwebStatus,
          duration: Date.now() - session.startedAt.getTime(),
          "recordingHealth.hasFullSnapshot": prevHasFs || hasFs,
          "recordingHealth.chunkCount": newChunkCount,
          "recordingHealth.lastChunkAt": new Date()
        }
      }
    );

    const elapsed = Date.now() - startedAt;
    if (elapsed > 5000) {
      console.warn(`[rrweb-chunk] slow write session=${sessionId} ms=${elapsed} bytes=${approxBytes}`);
    }

    return res.status(202).json({ ok: true });
  } catch (err) {
    if (isMongoStorageQuotaError(err)) {
      console.error("rrweb-chunk storage quota:", err.message || err);
      return storageQuotaResponse(res);
    }
    console.error("rrweb-chunk error:", err.message || err);
    if (err.message && /document too large|BSONObj size/i.test(err.message)) {
      return res.status(413).json({ ok: false, code: "chunk_too_large", message: "Chunk too large to store" });
    }
    return res.status(500).json({ error: "server error" });
  }
});

// GET /api/session/:sessionId/rrweb-chunks — ordered rrweb chunks for replayer
router.get("/session/:sessionId/rrweb-chunks", authMiddleware, async (req, res) => {
  try {
    const session = await getSessionForUser(req.params.sessionId, req.user.id);
    if (!session) return res.status(404).json({ error: "not found" });
    if (!session.hasRrweb && (!session.rrwebChunkCount || session.rrwebChunkCount === 0)) {
      return res.status(404).json({ error: "no rrweb recording" });
    }

    const chunks = await Event.find(
      { sessionId: session._id, type: "rrweb_chunk" },
      { "data.chunkIndex": 1, "data.segmentId": 1, "data.events": 1, "data.isCheckout": 1, timestamp: 1 }
    )
      .sort({ "data.segmentId": 1, "data.chunkIndex": 1, timestamp: 1 })
      .lean();

    return res.json({
      sessionId: session.sessionId,
      chunkCount: chunks.length,
      chunks: chunks.map((c) => ({
        chunkIndex: c.data.chunkIndex,
        segmentId: c.data.segmentId || null,
        isCheckout: c.data.isCheckout,
        recordedAt: c.timestamp,
        events: c.data.events
      }))
    });
  } catch (err) {
    console.error("rrweb-chunks error:", err);
    return res.status(500).json({ error: "server error" });
  }
});

// PATCH /api/session/:sessionId/annotate — star, tag, note
router.patch("/session/:sessionId/annotate", authMiddleware, async (req, res) => {
  try {
    const { starred, addTag, removeTag, note } = req.body;
    const session = await getSessionForUser(req.params.sessionId, req.user.id);
    if (!session) return res.status(404).json({ error: "not found" });

    if (typeof starred === "boolean") {
      await Session.updateOne({ _id: session._id }, { $set: { starred } });
    }
    if (addTag) {
      await Session.updateOne({ _id: session._id }, { $addToSet: { tags: String(addTag).slice(0, 64) } });
    }
    if (removeTag) {
      await Session.updateOne({ _id: session._id }, { $pull: { tags: removeTag } });
    }
    if (note) {
      await Event.create({
        sessionId: session._id,
        type: "note",
        data: { text: String(note).slice(0, 500), author: req.user.id },
        timestamp: Date.now(),
        pageIndex: 0
      });
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error("annotate error:", err);
    return res.status(500).json({ error: "server error" });
  }
});

module.exports = router;
