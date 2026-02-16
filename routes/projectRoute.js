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

module.exports = router;
