const express = require("express");
const Session = require("../modal/session");
const Project = require("../modal/project");
const Event = require("../modal/event");
const authMiddleware = require("../middleware/authMiddleware");

const router = express.Router();

function deriveDeviceType(userAgent) {
  if (!userAgent || typeof userAgent !== "string") return "desktop";
  const ua = userAgent.toLowerCase();
  if (/android/.test(ua)) return "android";
  if (/iphone|ipad|ipod/.test(ua)) return "ios";
  if (/tablet|ipad/.test(ua)) return "tablet";
  return "desktop";
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
  
    await Session.create({
      projectId: project._id,
      sessionId,
      url,
      userAgent,
      screen,
      viewport: viewport && typeof viewport.width === "number" && typeof viewport.height === "number" ? viewport : undefined,
      deviceType,
      ipAddress: req.ip,
      startedAt: new Date(),
      lastActivity: new Date()
    });
  
    res.json({ success: true });
  });

  // Save snapshot (tracker; no auth) — POST /api/session/capture
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
    await Session.findByIdAndUpdate(session._id, { snapshot: snapshot || "" });
    return res.json({ success: true });
  });

  // Helper: get session by sessionId and ensure it belongs to req.user
  async function getSessionForUser(sessionIdStr, userId) {
    const session = await Session.findOne({ sessionId: sessionIdStr }).populate("projectId");
    if (!session || !session.projectId) return null;
    if (session.projectId.userId.toString() !== userId) return null;
    return session;
  }

  // Get session events (protected; for replay) — GET /api/session/:sessionId/events
  router.get("/session/:sessionId/events", authMiddleware, async (req, res) => {
    const session = await getSessionForUser(req.params.sessionId, req.user.id);
    if (!session) {
      return res.status(404).json({ message: "Session not found" });
    }
    const events = await Event.find({ sessionId: session._id }).sort({ timestamp: 1 });
    return res.json(events.map(e => ({ type: e.type, data: e.data, timestamp: e.timestamp })));
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
      deviceType: session.deviceType
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
  
    // Map events for insertMany
    const formattedEvents = events.map(e => ({
      sessionId: session._id,
      type: e.type,
      data: e.data,
      timestamp: e.timestamp
    }));
  
    await Event.insertMany(formattedEvents);
  
    await Session.findByIdAndUpdate(session._id, {
      $inc: { eventCount: events.length },
      lastActivity: new Date(),
      duration: Date.now() - session.startedAt
    });
  
    res.json({ success: true });
  });

  module.exports = router;