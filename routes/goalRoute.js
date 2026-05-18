const express = require("express");
const mongoose = require("mongoose");
const Project = require("../modal/project");
const TrackedGoal = require("../modal/trackedGoal");
const GoalClickDaily = require("../modal/goalClickDaily");
const authMiddleware = require("../middleware/authMiddleware");
const {
  MAX_GOALS_PER_PROJECT,
  normalizeGoalKey,
  sanitizeSelector,
  WHATSAPP_TEMPLATE,
  utcDateKey
} = require("../utils/goalValidation");

const router = express.Router({ mergeParams: true });

async function getOwnedProject(req, res) {
  const project = await Project.findById(req.params.id);
  if (!project) {
    res.status(404).json({ message: "Project not found" });
    return null;
  }
  if (project.userId.toString() !== req.user.id) {
    res.status(403).json({ message: "Access denied" });
    return null;
  }
  return project;
}

function parseDays(q, defaultDays = 7) {
  const n = parseInt(q, 10);
  return Number.isFinite(n) && n >= 1 && n <= 365 ? n : defaultDays;
}

function dateRangeKeys(days) {
  const keys = [];
  const end = new Date();
  end.setUTCHours(0, 0, 0, 0);
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(end);
    d.setUTCDate(d.getUTCDate() - i);
    keys.push(utcDateKey(d));
  }
  return keys;
}

router.get("/", authMiddleware, async (req, res) => {
  try {
    const project = await getOwnedProject(req, res);
    if (!project) return;

    const days = parseDays(req.query.days, 7);
    const sinceKeys = dateRangeKeys(days);
    const sinceDate = sinceKeys[0];

    const goals = await TrackedGoal.find({ projectId: project._id }).sort({ createdAt: -1 }).lean();

    const rollups = await GoalClickDaily.aggregate([
      {
        $match: {
          projectId: project._id,
          date: { $gte: sinceDate }
        }
      },
      {
        $group: {
          _id: "$goalKey",
          clicks: { $sum: "$clicks" },
          uniqueSessions: { $sum: "$uniqueSessions" }
        }
      }
    ]);

    const rollupMap = new Map(rollups.map((r) => [r._id, r]));

    const list = goals.map((g) => {
      const stats = rollupMap.get(g.key) || { clicks: 0, uniqueSessions: 0 };
      return {
        id: g._id.toString(),
        key: g.key,
        name: g.name,
        selector: g.selector || "",
        urlPattern: g.urlPattern || "",
        enabled: g.enabled,
        clicks7d: stats.clicks,
        uniqueSessions7d: stats.uniqueSessions,
        createdAt: g.createdAt,
        updatedAt: g.updatedAt
      };
    });

    return res.json(list);
  } catch (err) {
    console.error("List goals error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
});

router.post("/", authMiddleware, async (req, res) => {
  try {
    const project = await getOwnedProject(req, res);
    if (!project) return;

    const count = await TrackedGoal.countDocuments({ projectId: project._id });
    if (count >= MAX_GOALS_PER_PROJECT) {
      return res.status(400).json({ message: `Maximum ${MAX_GOALS_PER_PROJECT} goals per project` });
    }

    let { key, name, selector, urlPattern, enabled, template } = req.body;

    if (template === "whatsapp") {
      key = WHATSAPP_TEMPLATE.key;
      name = name || WHATSAPP_TEMPLATE.name;
      selector = selector || WHATSAPP_TEMPLATE.selector;
      urlPattern = urlPattern ?? WHATSAPP_TEMPLATE.urlPattern;
    }

    const normKey = normalizeGoalKey(key);
    if (!normKey) {
      return res.status(400).json({ message: "Invalid goal key" });
    }

    if (!name || typeof name !== "string" || !name.trim()) {
      return res.status(400).json({ message: "Name is required" });
    }

    const cleanSelector = sanitizeSelector(selector);
    if (selector && cleanSelector === null) {
      return res.status(400).json({ message: "Invalid CSS selector" });
    }

    const existing = await TrackedGoal.findOne({ projectId: project._id, key: normKey });
    if (existing) {
      return res.status(409).json({ message: "Goal key already exists" });
    }

    const goal = await TrackedGoal.create({
      projectId: project._id,
      key: normKey,
      name: name.trim().slice(0, 120),
      selector: cleanSelector || "",
      urlPattern: typeof urlPattern === "string" ? urlPattern.trim().slice(0, 500) : "",
      enabled: enabled !== false
    });

    return res.status(201).json(goal);
  } catch (err) {
    console.error("Create goal error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
});

router.patch("/:goalId", authMiddleware, async (req, res) => {
  try {
    const project = await getOwnedProject(req, res);
    if (!project) return;

    if (!mongoose.Types.ObjectId.isValid(req.params.goalId)) {
      return res.status(400).json({ message: "Invalid goal id" });
    }

    const goal = await TrackedGoal.findOne({ _id: req.params.goalId, projectId: project._id });
    if (!goal) {
      return res.status(404).json({ message: "Goal not found" });
    }

    const { name, selector, urlPattern, enabled } = req.body;

    if (name !== undefined) {
      if (!name || typeof name !== "string" || !name.trim()) {
        return res.status(400).json({ message: "Name cannot be empty" });
      }
      goal.name = name.trim().slice(0, 120);
    }

    if (selector !== undefined) {
      const cleanSelector = sanitizeSelector(selector);
      if (selector && cleanSelector === null) {
        return res.status(400).json({ message: "Invalid CSS selector" });
      }
      goal.selector = cleanSelector || "";
    }

    if (urlPattern !== undefined) {
      goal.urlPattern = typeof urlPattern === "string" ? urlPattern.trim().slice(0, 500) : "";
    }

    if (enabled !== undefined) {
      goal.enabled = Boolean(enabled);
    }

    await goal.save();
    return res.json(goal);
  } catch (err) {
    console.error("Update goal error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
});

router.delete("/:goalId", authMiddleware, async (req, res) => {
  try {
    const project = await getOwnedProject(req, res);
    if (!project) return;

    if (!mongoose.Types.ObjectId.isValid(req.params.goalId)) {
      return res.status(400).json({ message: "Invalid goal id" });
    }

    const result = await TrackedGoal.deleteOne({ _id: req.params.goalId, projectId: project._id });
    if (result.deletedCount === 0) {
      return res.status(404).json({ message: "Goal not found" });
    }

    return res.json({ success: true });
  } catch (err) {
    console.error("Delete goal error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
});

module.exports = router;
