const express = require("express");
const Project = require("../modal/project");
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
