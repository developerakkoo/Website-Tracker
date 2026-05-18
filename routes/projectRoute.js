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
const Event = require("../modal/event");
const TrackedGoal = require("../modal/trackedGoal");
const GoalClickDaily = require("../modal/goalClickDaily");
const { utcDateKey } = require("../utils/goalValidation");
const HEATMAP_GRID_SIZE = 100;

function parseDays(q, defaultDays = 30) {
  const n = parseInt(q, 10);
  return Number.isFinite(n) && n >= 1 && n <= 365 ? n : defaultDays;
}

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

function utcDateRange(days) {
  const end = new Date();
  end.setUTCHours(23, 59, 59, 999);
  const since = new Date(end);
  since.setUTCDate(since.getUTCDate() - (days - 1));
  since.setUTCHours(0, 0, 0, 0);
  return { since, end };
}

function prevPeriodSince(since, days) {
  const prev = new Date(since);
  prev.setUTCDate(prev.getUTCDate() - days);
  return prev;
}

function fillDailySeries(rows, since, days) {
  const map = new Map(rows.map((r) => [r.date, r.value]));
  const data = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(since);
    d.setUTCDate(d.getUTCDate() + i);
    const key = d.toISOString().slice(0, 10);
    data.push({ date: key, value: map.get(key) ?? 0 });
  }
  return data;
}

function startOfTodayUtc() {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function startOfWeekMondayUtc() {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  const day = d.getUTCDay();
  const diff = day === 0 ? 6 : day - 1;
  d.setUTCDate(d.getUTCDate() - diff);
  return d;
}

function sessionDurationExpr() {
  return {
    $cond: [
      { $gt: ["$duration", 0] },
      "$duration",
      { $max: [0, { $subtract: ["$lastActivity", "$startedAt"] }] }
    ]
  };
}

function pageCountExpr() {
  return {
    $max: [
      1,
      { $size: { $ifNull: ["$pages", []] } }
    ]
  };
}

function scrollDepthPercent(gridObj) {
  if (!gridObj || typeof gridObj !== "object") return 0;
  let sum = 0;
  let total = 0;
  for (let x = 0; x < HEATMAP_GRID_SIZE; x++) {
    const count = gridObj[`0_${x}`] || 0;
    if (count > 0) {
      sum += count * ((x / (HEATMAP_GRID_SIZE - 1)) * 100);
      total += count;
    }
  }
  return total > 0 ? Math.round(sum / total) : 0;
}

function percentChange(current, previous) {
  if (!previous || previous === 0) return null;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

async function aggregateOverviewStats(projectId, filter) {
  const pid = projectId;
  const [totalSessions, pageviewAgg, uniqueIps, durationAgg, bounceAgg] = await Promise.all([
    Session.countDocuments(filter),
    Session.aggregate([
      { $match: filter },
      { $group: { _id: null, total: { $sum: pageCountExpr() } } }
    ]),
    Session.distinct("ipAddress", filter),
    Session.aggregate([
      { $match: filter },
      { $group: { _id: null, avg: { $avg: sessionDurationExpr() } } }
    ]),
    Session.aggregate([
      { $match: filter },
      {
        $group: {
          _id: null,
          bounces: {
            $sum: {
              $cond: [{ $lte: [{ $size: { $ifNull: ["$pages", []] } }, 1] }, 1, 0]
            }
          }
        }
      }
    ])
  ]);

  const totalPageviews = pageviewAgg[0]?.total || 0;
  const uniqueVisitors = uniqueIps.filter(Boolean).length;
  const avgSessionDuration = Math.round(durationAgg[0]?.avg || 0);
  const bounces = bounceAgg[0]?.bounces || 0;
  const bounceRate =
    totalSessions > 0 ? Math.round((bounces / totalSessions) * 1000) / 10 : 0;
  const avgPagesPerSession =
    totalSessions > 0 ? Math.round((totalPageviews / totalSessions) * 100) / 100 : 0;

  return {
    totalSessions,
    totalPageviews,
    uniqueVisitors,
    avgSessionDuration,
    bounceRate,
    avgPagesPerSession
  };
}

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

    return res.json({
      grid,
      maxValue,
      updatedAt: heatmap?.updatedAt ? heatmap.updatedAt.toISOString() : null
    });
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
    const sessions = await Session.find({
      projectId: project._id,
      eventCount: { $gt: 0 }
    })
      .sort({ startedAt: -1 })
      .limit(100)
      .select("sessionId startedAt url eventCount duration deviceType viewport pages")
      .lean();
    return res.json(sessions);
  } catch (error) {
    console.error("Get project sessions error:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
});

// --- Analytics (must be before /:id) ---

router.get("/:id/analytics/overview", authMiddleware, async (req, res) => {
  try {
    const project = await getOwnedProject(req, res);
    if (!project) return;

    const days = parseDays(req.query.days);
    const { since } = utcDateRange(days);
    const prevSince = prevPeriodSince(since, days);
    const filter = { projectId: project._id, startedAt: { $gte: since } };
    const prevFilter = { projectId: project._id, startedAt: { $gte: prevSince, $lt: since } };

    const [current, previous, lastSession, activeToday, activeThisWeek] = await Promise.all([
      aggregateOverviewStats(project._id, filter),
      aggregateOverviewStats(project._id, prevFilter),
      Session.findOne(filter).sort({ lastActivity: -1 }).select("lastActivity").lean(),
      Session.countDocuments({ projectId: project._id, startedAt: { $gte: startOfTodayUtc() } }),
      Session.countDocuments({ projectId: project._id, startedAt: { $gte: startOfWeekMondayUtc() } })
    ]);

    return res.json({
      ...current,
      lastSeen: lastSession?.lastActivity ? new Date(lastSession.lastActivity).toISOString() : null,
      activeToday,
      activeThisWeek,
      changes: {
        totalSessions: percentChange(current.totalSessions, previous.totalSessions),
        totalPageviews: percentChange(current.totalPageviews, previous.totalPageviews)
      }
    });
  } catch (err) {
    console.error("Analytics overview error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
});

router.get("/:id/analytics/timeseries", authMiddleware, async (req, res) => {
  try {
    const project = await getOwnedProject(req, res);
    if (!project) return;

    const days = parseDays(req.query.days);
    const metric = ["sessions", "pageviews", "events"].includes(req.query.metric)
      ? req.query.metric
      : "sessions";
    const { since } = utcDateRange(days);
    const sinceMs = since.getTime();
    const filter = { projectId: project._id, startedAt: { $gte: since } };

    let rows = [];

    if (metric === "sessions") {
      rows = await Session.aggregate([
        { $match: filter },
        {
          $group: {
            _id: {
              $dateToString: { format: "%Y-%m-%d", date: "$startedAt", timezone: "UTC" }
            },
            value: { $sum: 1 }
          }
        },
        { $project: { _id: 0, date: "$_id", value: 1 } },
        { $sort: { date: 1 } }
      ]);
    } else if (metric === "pageviews") {
      rows = await Session.aggregate([
        { $match: filter },
        { $unwind: { path: "$pages", preserveNullAndEmptyArrays: true } },
        {
          $group: {
            _id: {
              $dateToString: {
                format: "%Y-%m-%d",
                date: { $ifNull: ["$pages.startedAt", "$startedAt"] },
                timezone: "UTC"
              }
            },
            value: { $sum: 1 }
          }
        },
        { $project: { _id: 0, date: "$_id", value: 1 } },
        { $sort: { date: 1 } }
      ]);
    } else {
      rows = await Event.aggregate([
        {
          $lookup: {
            from: "sessions",
            localField: "sessionId",
            foreignField: "_id",
            as: "session"
          }
        },
        { $unwind: "$session" },
        {
          $match: {
            "session.projectId": project._id,
            timestamp: { $gte: sinceMs }
          }
        },
        {
          $group: {
            _id: {
              $dateToString: {
                format: "%Y-%m-%d",
                date: { $toDate: "$timestamp" },
                timezone: "UTC"
              }
            },
            value: { $sum: 1 }
          }
        },
        { $project: { _id: 0, date: "$_id", value: 1 } },
        { $sort: { date: 1 } }
      ]);
    }

    return res.json({ data: fillDailySeries(rows, since, days) });
  } catch (err) {
    console.error("Analytics timeseries error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
});

router.get("/:id/analytics/pages", authMiddleware, async (req, res) => {
  try {
    const project = await getOwnedProject(req, res);
    if (!project) return;

    const days = parseDays(req.query.days);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 10));
    const metric = ["views", "entries", "exits", "avgScrollDepth"].includes(req.query.metric)
      ? req.query.metric
      : "views";
    const { since } = utcDateRange(days);
    const prevSince = prevPeriodSince(since, days);
    const filter = { projectId: project._id, startedAt: { $gte: since } };
    const prevFilter = { projectId: project._id, startedAt: { $gte: prevSince, $lt: since } };

    let data = [];

    if (metric === "views") {
      const [current, previous] = await Promise.all([
        Session.aggregate([
          { $match: filter },
          { $unwind: "$pages" },
          { $match: { "pages.url": { $nin: [null, ""] } } },
          { $group: { _id: "$pages.url", value: { $sum: 1 } } },
          { $sort: { value: -1 } },
          { $limit: limit },
          { $project: { _id: 0, url: "$_id", value: 1 } }
        ]),
        Session.aggregate([
          { $match: prevFilter },
          { $unwind: "$pages" },
          { $match: { "pages.url": { $nin: [null, ""] } } },
          { $group: { _id: "$pages.url", value: { $sum: 1 } } }
        ])
      ]);
      const prevMap = new Map(previous.map((r) => [r._id, r.value]));
      data = current.map((row) => ({
        url: row.url,
        value: row.value,
        change: percentChange(row.value, prevMap.get(row.url))
      }));
    } else if (metric === "entries") {
      const rows = await Session.aggregate([
        { $match: filter },
        { $match: { "pages.0": { $exists: true } } },
        { $group: { _id: { $arrayElemAt: ["$pages.url", 0] }, value: { $sum: 1 } } },
        { $match: { _id: { $nin: [null, ""] } } },
        { $sort: { value: -1 } },
        { $limit: limit },
        { $project: { _id: 0, url: "$_id", value: 1 } }
      ]);
      data = rows.map((row) => ({ url: row.url, value: row.value, change: null }));
    } else if (metric === "exits") {
      const rows = await Session.aggregate([
        { $match: filter },
        { $match: { pages: { $exists: true, $ne: [] } } },
        {
          $group: {
            _id: { $arrayElemAt: ["$pages.url", -1] },
            value: { $sum: 1 }
          }
        },
        { $match: { _id: { $nin: [null, ""] } } },
        { $sort: { value: -1 } },
        { $limit: limit },
        { $project: { _id: 0, url: "$_id", value: 1 } }
      ]);
      data = rows.map((row) => ({ url: row.url, value: row.value, change: null }));
    } else {
      const urls = await Session.distinct("pages.url", filter);
      const validUrls = urls.filter(Boolean).slice(0, limit * 3);
      const heatmaps = await Heatmap.find({
        projectId: project._id,
        url: { $in: validUrls },
        type: "scroll",
        deviceType: "all"
      })
        .select("url grid")
        .lean();
      const depthByUrl = new Map();
      for (const hm of heatmaps) {
        depthByUrl.set(hm.url, scrollDepthPercent(hm.grid || {}));
      }
      data = validUrls
        .map((url) => ({
          url,
          value: depthByUrl.get(url) ?? 0,
          change: null
        }))
        .sort((a, b) => b.value - a.value)
        .slice(0, limit);
    }

    return res.json({ data });
  } catch (err) {
    console.error("Analytics pages error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
});

router.get("/:id/analytics/devices", authMiddleware, async (req, res) => {
  try {
    const project = await getOwnedProject(req, res);
    if (!project) return;

    const days = parseDays(req.query.days);
    const { since } = utcDateRange(days);
    const filter = { projectId: project._id, startedAt: { $gte: since } };

    const [deviceGroups, viewportGroups] = await Promise.all([
      Session.aggregate([
        { $match: filter },
        {
          $group: {
            _id: { $ifNull: ["$deviceType", "unknown"] },
            sessions: { $sum: 1 }
          }
        },
        { $sort: { sessions: -1 } }
      ]),
      Session.aggregate([
        {
          $match: {
            ...filter,
            "viewport.width": { $exists: true, $ne: null },
            "viewport.height": { $exists: true, $ne: null }
          }
        },
        {
          $group: {
            _id: { width: "$viewport.width", height: "$viewport.height" },
            count: { $sum: 1 }
          }
        },
        { $sort: { count: -1 } },
        { $limit: 8 },
        {
          $project: {
            _id: 0,
            width: "$_id.width",
            height: "$_id.height",
            count: 1
          }
        }
      ])
    ]);

    const total = deviceGroups.reduce((s, g) => s + g.sessions, 0);
    const breakdown = deviceGroups.map((g) => ({
      device: g._id,
      sessions: g.sessions,
      percentage: total > 0 ? Math.round((g.sessions / total) * 1000) / 10 : 0
    }));

    return res.json({ breakdown, viewports: viewportGroups });
  } catch (err) {
    console.error("Analytics devices error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
});

router.get("/:id/analytics/engagement", authMiddleware, async (req, res) => {
  try {
    const project = await getOwnedProject(req, res);
    if (!project) return;

    const days = parseDays(req.query.days);
    const { since } = utcDateRange(days);
    const filter = { projectId: project._id, startedAt: { $gte: since } };

    const [durationResult, depthResult] = await Promise.all([
      Session.aggregate([
        { $match: filter },
        {
          $bucket: {
            groupBy: sessionDurationExpr(),
            boundaries: [0, 10000, 30000, 60000, 300000, Number.MAX_SAFE_INTEGER],
            default: "other",
            output: { count: { $sum: 1 } }
          }
        }
      ]),
      Session.aggregate([
        { $match: filter },
        {
          $addFields: {
            pageDepth: {
              $max: [1, { $size: { $ifNull: ["$pages", []] } }]
            }
          }
        },
        {
          $bucket: {
            groupBy: "$pageDepth",
            boundaries: [1, 2, 3, 6, Number.MAX_SAFE_INTEGER],
            default: "other",
            output: { count: { $sum: 1 } }
          }
        }
      ])
    ]);

    const durationLabels = {
      0: "0–10s",
      10000: "10–30s",
      30000: "30–60s",
      60000: "1–5min",
      300000: "5min+"
    };

    const durationBuckets = [0, 10000, 30000, 60000, 300000].map((b) => ({
      label: durationLabels[b],
      count: durationResult.find((r) => r._id === b)?.count || 0
    }));

    const depthBuckets = [
      { boundary: 1, label: "1 page" },
      { boundary: 2, label: "2 pages" },
      { boundary: 3, label: "3–5 pages" },
      { boundary: 6, label: "6+ pages" }
    ].map(({ boundary, label }) => ({
      label,
      count: depthResult.find((r) => r._id === boundary)?.count || 0
    }));

    return res.json({ durationBuckets, sessionDepthBuckets: depthBuckets });
  } catch (err) {
    console.error("Analytics engagement error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
});

router.get("/:id/goals/analytics/summary", authMiddleware, async (req, res) => {
  try {
    const project = await getOwnedProject(req, res);
    if (!project) return;

    const days = parseDays(req.query.days, 7);
    const sinceKeys = [];
    const end = new Date();
    end.setUTCHours(0, 0, 0, 0);
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(end);
      d.setUTCDate(d.getUTCDate() - i);
      sinceKeys.push(utcDateKey(d));
    }
    const sinceDate = sinceKeys[0];

    const { since } = utcDateRange(days);
    const sessionFilter = { projectId: project._id, startedAt: { $gte: since } };

    const [goals, rollups, totalSessions, totalPageviews] = await Promise.all([
      TrackedGoal.find({ projectId: project._id }).lean(),
      GoalClickDaily.aggregate([
        { $match: { projectId: project._id, date: { $gte: sinceDate } } },
        {
          $group: {
            _id: "$goalKey",
            clicks: { $sum: "$clicks" },
            uniqueSessions: { $sum: "$uniqueSessions" }
          }
        }
      ]),
      Session.countDocuments(sessionFilter),
      Session.aggregate([
        { $match: sessionFilter },
        {
          $project: {
            pageCount: { $max: [1, { $size: { $ifNull: ["$pages", []] } }] }
          }
        },
        { $group: { _id: null, total: { $sum: "$pageCount" } } }
      ])
    ]);

    const rollupMap = new Map(rollups.map((r) => [r._id, r]));
    const pageviews = totalPageviews[0]?.total || 0;

    const goalStats = goals.map((g) => {
      const stats = rollupMap.get(g.key) || { clicks: 0, uniqueSessions: 0 };
      const ctr =
        pageviews > 0 ? Math.round((stats.clicks / pageviews) * 10000) / 100 : 0;
      const sessionRate =
        totalSessions > 0
          ? Math.round((stats.uniqueSessions / totalSessions) * 10000) / 100
          : 0;
      return {
        goalId: g._id,
        key: g.key,
        name: g.name,
        enabled: g.enabled,
        clicks: stats.clicks,
        uniqueSessions: stats.uniqueSessions,
        ctr,
        sessionRate
      };
    });

    const totalClicks = goalStats.reduce((s, g) => s + g.clicks, 0);
    const totalUnique = goalStats.reduce((s, g) => s + g.uniqueSessions, 0);
    const topGoal = [...goalStats].sort((a, b) => b.clicks - a.clicks)[0] || null;

    return res.json({
      days,
      totalSessions,
      totalPageviews: pageviews,
      totalClicks,
      totalUniqueGoalSessions: totalUnique,
      conversionRate:
        totalSessions > 0 ? Math.round((totalUnique / totalSessions) * 10000) / 100 : 0,
      topGoal: topGoal ? { key: topGoal.key, name: topGoal.name, clicks: topGoal.clicks } : null,
      goals: goalStats
    });
  } catch (err) {
    console.error("Goals analytics summary error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
});

router.get("/:id/goals/analytics/timeseries", authMiddleware, async (req, res) => {
  try {
    const project = await getOwnedProject(req, res);
    if (!project) return;

    const days = parseDays(req.query.days, 30);
    const goalKey = (req.query.goalKey || "").toLowerCase();
    if (!goalKey) {
      return res.status(400).json({ message: "goalKey required" });
    }

    const { since } = utcDateRange(days);
    const sinceDate = utcDateKey(since);

    const rows = await GoalClickDaily.find({
      projectId: project._id,
      goalKey,
      date: { $gte: sinceDate }
    })
      .sort({ date: 1 })
      .lean();

    const clicks = fillDailySeries(
      rows.map((r) => ({ date: r.date, value: r.clicks })),
      since,
      days
    );
    const uniqueSessions = fillDailySeries(
      rows.map((r) => ({ date: r.date, value: r.uniqueSessions })),
      since,
      days
    );

    return res.json({ goalKey, days, clicks, uniqueSessions });
  } catch (err) {
    console.error("Goals timeseries error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
});

router.get("/:id/goals/analytics/pages", authMiddleware, async (req, res) => {
  try {
    const project = await getOwnedProject(req, res);
    if (!project) return;

    const days = parseDays(req.query.days, 7);
    const goalKey = (req.query.goalKey || "").toLowerCase();
    if (!goalKey) {
      return res.status(400).json({ message: "goalKey required" });
    }

    const { since } = utcDateRange(days);
    const sinceMs = since.getTime();

    const sessions = await Session.find({
      projectId: project._id,
      startedAt: { $gte: since }
    })
      .select("_id")
      .lean();

    const sessionIds = sessions.map((s) => s._id);
    if (sessionIds.length === 0) {
      return res.json({ goalKey, pages: [] });
    }

    const rows = await Event.aggregate([
      {
        $match: {
          sessionId: { $in: sessionIds },
          type: "goal_click",
          "data.goalKey": goalKey,
          timestamp: { $gte: sinceMs }
        }
      },
      {
        $group: {
          _id: "$data.pageUrl",
          clicks: { $sum: 1 }
        }
      },
      { $sort: { clicks: -1 } },
      { $limit: 50 }
    ]);

    const pages = rows
      .filter((r) => r._id)
      .map((r) => ({
        url: r._id,
        clicks: r.clicks
      }));

    return res.json({ goalKey, pages });
  } catch (err) {
    console.error("Goals pages analytics error:", err);
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
