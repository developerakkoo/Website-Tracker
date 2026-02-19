const express = require("express");
const Project = require("../modal/project");

const router = express.Router();

// Installation ping endpoint (public, no auth required)
router.post("/ping", async (req, res) => {
  try {
    const { apiKey, url } = req.body;

    if (!apiKey || !url) {
      return res.status(400).json({ message: "apiKey and url are required" });
    }

    const project = await Project.findOne({ apiKey });

    if (!project) {
      return res.status(403).json({ message: "Invalid API key" });
    }

    // Update installation status
    project.installed = true;
    project.lastSeen = new Date();
    project.lastUrl = url;
    await project.save();

    res.json({ success: true, message: "Installation verified" });
  } catch (error) {
    console.error("Installation ping error:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

module.exports = router;
