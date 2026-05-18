const GoalClickDaily = require("../modal/goalClickDaily");
const TrackedGoal = require("../modal/trackedGoal");
const { utcDateKey } = require("./goalValidation");

const FLUSH_INTERVAL_MS = 5000;

let clickBuffer = new Map();
let uniqueBuffer = new Map();
let flushTimer = null;

function bufferKey(projectId, goalKey, date) {
  return `${projectId}|${goalKey}|${date}`;
}

function uniqueKey(projectId, goalKey, date, sessionId) {
  return `${projectId}|${goalKey}|${date}|${sessionId}`;
}

async function loadEnabledGoalKeys(projectId) {
  const goals = await TrackedGoal.find({ projectId, enabled: true }).select("key").lean();
  return new Set(goals.map((g) => g.key));
}

function addGoalClicks(projectId, sessionId, goalEvents, enabledKeys) {
  if (!projectId || !sessionId || !Array.isArray(goalEvents) || goalEvents.length === 0) {
    return;
  }

  const date = utcDateKey();
  const projectStr = projectId.toString();
  const sessionStr = sessionId.toString();

  goalEvents.forEach((ev) => {
    const data = ev.data || {};
    const goalKey = typeof data.goalKey === "string" ? data.goalKey.toLowerCase() : "";
    if (!goalKey || (enabledKeys && !enabledKeys.has(goalKey))) {
      return;
    }

    const bk = bufferKey(projectStr, goalKey, date);
    clickBuffer.set(bk, (clickBuffer.get(bk) || 0) + 1);

    const uk = uniqueKey(projectStr, goalKey, date, sessionStr);
    if (!uniqueBuffer.has(uk)) {
      uniqueBuffer.set(uk, { projectId: projectStr, goalKey, date });
    }
  });
}

function flush() {
  const clicks = clickBuffer;
  const uniques = uniqueBuffer;
  clickBuffer = new Map();
  uniqueBuffer = new Map();

  const ops = [];

  clicks.forEach((count, key) => {
    const [projectId, goalKey, date] = key.split("|");
    ops.push(
      GoalClickDaily.findOneAndUpdate(
        { projectId, goalKey, date },
        { $inc: { clicks: count } },
        { upsert: true, new: true }
      )
    );
  });

  uniques.forEach((entry) => {
    ops.push(
      GoalClickDaily.findOneAndUpdate(
        { projectId: entry.projectId, goalKey: entry.goalKey, date: entry.date },
        { $inc: { uniqueSessions: 1 } },
        { upsert: true, new: true }
      )
    );
  });

  if (ops.length > 0) {
    Promise.all(ops).catch((err) => {
      if (err) console.error("Goal click flush error:", err.message);
    });
  }
}

function startFlushInterval() {
  if (flushTimer) return;
  flushTimer = setInterval(flush, FLUSH_INTERVAL_MS);
  if (flushTimer.unref) flushTimer.unref();
}

startFlushInterval();

module.exports = { addGoalClicks, flush, loadEnabledGoalKeys };
