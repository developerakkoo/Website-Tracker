const express = require("express");
const Project = require("../modal/project");
const TrackedGoal = require("../modal/trackedGoal");

const router = express.Router();

router.get("/goals", async (req, res) => {
  try {
    const { apiKey } = req.query;
    if (!apiKey) {
      return res.status(400).json({ message: "apiKey required" });
    }

    const project = await Project.findOne({ apiKey }).select("_id").lean();
    if (!project) {
      return res.status(403).json({ message: "Invalid API key" });
    }

    const goals = await TrackedGoal.find({ projectId: project._id, enabled: true })
      .select("key name selector urlPattern")
      .lean();

    res.setHeader("Cache-Control", "public, max-age=60");
    return res.json({
      goals: goals.map((g) => ({
        key: g.key,
        name: g.name,
        selector: g.selector || "",
        urlPattern: g.urlPattern || ""
      }))
    });
  } catch (err) {
    console.error("Tracker goals error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
});

module.exports = router;
