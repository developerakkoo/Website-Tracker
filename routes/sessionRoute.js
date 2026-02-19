const express = require("express");
const Session = require("../modal/session");
const Project = require("../modal/project");
const Event = require("../modal/event");
const authMiddleware = require("../middleware/authMiddleware");

const router = express.Router();

// Initialize Session
router.post("/session/init", async (req, res) => {
    const { apiKey, sessionId, url, userAgent, screen } = req.body;
  
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
  
    await Session.create({
      projectId: project._id,
      sessionId,
      url,
      userAgent,
      screen,
      ipAddress: req.ip,
      startedAt: new Date(),
      lastActivity: new Date()
    });
  
    res.json({ success: true });
  });

  // Track Events
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