const express = require("express");
const Session = require("../modal/session");
const Project = require("../modal/project");
const Event = require("../modal/event");
const authMiddleware = require("../middleware/authMiddleware");
const heatmapAggregator = require("../utils/heatmapAggregator");
const goalClickAggregator = require("../utils/goalClickAggregator");

const router = express.Router();

const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;

function deriveDeviceType(userAgent) {
  if (!userAgent || typeof userAgent !== "string") return "desktop";
  const ua = userAgent.toLowerCase();
  if (/android/.test(ua)) return "android";
  if (/iphone|ipad|ipod/.test(ua)) return "ios";
  if (/tablet|ipad/.test(ua)) return "tablet";
  return "desktop";
}

function normalizeSnapshot(snapshot) {
  let s = snapshot || "";
  if (s.length > MAX_SNAPSHOT_BYTES) s = s.slice(0, MAX_SNAPSHOT_BYTES);
  return s;
}

// Initialize Session (POST /api/session/init)
router.post("/session/init", async (req, res) => {
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
    return res.json({ message: "Session already exists" });
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
    pages: [
      {
        url: url || "",
        snapshot: "",
        startedAt,
        viewport: vp,
        eventsCount: 0
      }
    ]
  });

  res.json({ success: true });
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
        eventsCount: 0
      }
    },
    $set: { url, lastActivity: new Date(), viewport: vp || session.viewport }
  });

  res.json({ success: true });
});

// Save snapshot — POST /api/session/capture (latest page + legacy snapshot field)
router.post("/session/capture", async (req, res) => {
  const { apiKey, sessionId, snapshot } = req.body;
  if (!apiKey || !sessionId) {
    return res.status(400).json({ message: "Missing required fields" });
  }
  const project = await Project.findOne({ apiKey });
  if (!project) {
    return res.status(403).json({ message: "Invalid API key" });
  }
  const session = await Session.findOne({ sessionId });
  if (!session) {
    return res.status(404).json({ message: "Session not found" });
  }
  const snap = normalizeSnapshot(snapshot);
  const so = session.toObject();
  let pages = Array.isArray(so.pages) ? so.pages.map((p) => ({ ...p })) : [];
  if (pages.length === 0) {
    pages.push({
      url: session.url || "",
      snapshot: snap,
      startedAt: session.startedAt,
      viewport: session.viewport,
      eventsCount: 0
    });
  } else {
    pages[pages.length - 1] = { ...pages[pages.length - 1], snapshot: snap };
  }
  await Session.findByIdAndUpdate(session._id, { $set: { snapshot: snap, pages } });
  return res.json({ success: true });
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
  if (!session.eventCount || session.eventCount <= 0) {
    return res.status(404).json({ message: "This visit has no recording to play" });
  }

  const allEvents = await Event.find({ sessionId: session._id }).sort({ timestamp: 1 }).lean();
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
  if (!session.eventCount || session.eventCount <= 0) {
    return res.status(404).json({ message: "This visit has no recording to play" });
  }
  const events = await Event.find({ sessionId: session._id }).sort({ timestamp: 1 });
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
    pages: session.pages || []
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

  const incUpdate = { eventCount: events.length };
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
    events
  );

  const goalEvents = events.filter((e) => e.type === "goal_click" && e.data?.goalKey);
  if (goalEvents.length > 0) {
    const enabledKeys = await goalClickAggregator.loadEnabledGoalKeys(project._id);
    goalClickAggregator.addGoalClicks(project._id, session._id, goalEvents, enabledKeys);
  }

  res.json({ success: true });
});

module.exports = router;
