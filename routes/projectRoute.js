const express = require("express");
const Project = require("../modal/project");
const Session = require("../modal/session");
const authMiddleware = require("../middleware/authMiddleware");
const generateApiKey = require("../utils/generateAPIKey");

const router = express.Router();

// Create Project
router.post("/", authMiddleware, async (req, res) => {
  const { name } = req.body;

  const apiKey = generateApiKey();

  const project = new Project({
    userId: req.user.id,
    name,
    apiKey
  });

  await project.save();

  res.json(project);
});

// Get User Projects
router.get("/", authMiddleware, async (req, res) => {
  const projects = await Project.find({ userId: req.user.id });
  res.json(projects);
});

// Get Project Sessions (must be before /:id)
router.get("/:id/sessions", authMiddleware, async (req, res) => {
  try {
    const project = await Project.findById(req.params.id);
    if (!project) {
      return res.status(404).json({ message: "Project not found" });
    }
    if (project.userId.toString() !== req.user.id) {
      return res.status(403).json({ message: "Access denied" });
    }
    const sessions = await Session.find({ projectId: project._id })
      .sort({ startedAt: -1 })
      .limit(100)
      .select("sessionId startedAt url eventCount duration deviceType viewport")
      .lean();
    return res.json(sessions);
  } catch (error) {
    console.error("Get project sessions error:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
});

// Get Single Project
router.get("/:id", authMiddleware, async (req, res) => {
  try {
    const project = await Project.findById(req.params.id);

    if (!project) {
      return res.status(404).json({ message: "Project not found" });
    }

    // Verify ownership
    if (project.userId.toString() !== req.user.id) {
      return res.status(403).json({ message: "Access denied" });
    }

    res.json(project);
  } catch (error) {
    console.error("Get project error:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

// Get Project Status
router.get("/:id/status", authMiddleware, async (req, res) => {
  try {
    const project = await Project.findById(req.params.id);

    if (!project) {
      return res.status(404).json({ message: "Project not found" });
    }

    // Verify ownership
    if (project.userId.toString() !== req.user.id) {
      return res.status(403).json({ message: "Access denied" });
    }

    res.json({
      installed: project.installed || false,
      lastSeen: project.lastSeen,
      lastUrl: project.lastUrl
    });
  } catch (error) {
    console.error("Get project status error:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

module.exports = router;
