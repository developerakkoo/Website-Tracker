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

// Get heatmaps (must be before /:id)
const Heatmap = require("../modal/heatmap");
const HEATMAP_GRID_SIZE = 100;

function gridObjectTo2D(gridObj, type) {
  const grid = [];
  if (type === "scroll") {
    const row = Array(HEATMAP_GRID_SIZE).fill(0);
    for (let x = 0; x < HEATMAP_GRID_SIZE; x++) {
      const key = `0_${x}`;
      row[x] = gridObj[key] || 0;
    }
    grid.push(row);
  } else {
    for (let y = 0; y < HEATMAP_GRID_SIZE; y++) {
      const row = [];
      for (let x = 0; x < HEATMAP_GRID_SIZE; x++) {
        const key = `${y}_${x}`;
        row.push(gridObj[key] || 0);
      }
      grid.push(row);
    }
  }
  return grid;
}

router.get("/:id/heatmaps", authMiddleware, async (req, res) => {
  try {
    const project = await Project.findById(req.params.id);
    if (!project) return res.status(404).json({ message: "Project not found" });
    if (project.userId.toString() !== req.user.id) return res.status(403).json({ message: "Access denied" });

    const { url, type, deviceType } = req.query;
    if (!url || !type) return res.status(400).json({ message: "url and type are required" });
    if (!["click", "scroll", "attention"].includes(type)) return res.status(400).json({ message: "type must be click, scroll, or attention" });

    const filter = { projectId: project._id, url, type };
    if (deviceType && deviceType !== "all") filter.deviceType = deviceType;
    else filter.deviceType = "all";

    let heatmap = await Heatmap.findOne(filter).lean();
    const gridObj = heatmap?.grid || {};
    const grid = gridObjectTo2D(gridObj, type);
    let maxValue = 0;
    for (let y = 0; y < grid.length; y++) {
      for (let x = 0; x < grid[y].length; x++) {
        if (grid[y][x] > maxValue) maxValue = grid[y][x];
      }
    }

    return res.json({ grid, maxValue });
  } catch (err) {
    console.error("Get heatmaps error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
});

router.get("/:id/heatmaps/urls", authMiddleware, async (req, res) => {
  try {
    const project = await Project.findById(req.params.id);
    if (!project) return res.status(404).json({ message: "Project not found" });
    if (project.userId.toString() !== req.user.id) return res.status(403).json({ message: "Access denied" });
    const urls = await Heatmap.distinct("url", { projectId: project._id });
    return res.json({ urls: urls.filter(Boolean).sort() });
  } catch (err) {
    console.error("Get heatmap urls error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
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
