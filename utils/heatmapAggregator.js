const Heatmap = require("../modal/heatmap");

const GRID_SIZE = 100;
const FLUSH_INTERVAL_MS = 5000;

let buffer = new Map();
let flushTimer = null;

function gridKey(y, x) {
  return `${y}_${x}`;
}

function clampCell(v) {
  return Math.max(0, Math.min(GRID_SIZE - 1, Math.floor(v)));
}

function ensureBufferKey(projectId, url, type, deviceType) {
  const key = `${projectId}|${url}|${type}|${deviceType || "all"}`;
  if (!buffer.has(key)) {
    buffer.set(key, { projectId, url, type, deviceType: deviceType || "all", grid: {} });
  }
  return buffer.get(key);
}

function addClickOrAttention(entry, x, y, viewportWidth, viewportHeight) {
  if (!viewportWidth || !viewportHeight) return;
  const cellX = clampCell((x / viewportWidth) * GRID_SIZE);
  const cellY = clampCell((y / viewportHeight) * GRID_SIZE);
  const key = gridKey(cellY, cellX);
  entry.grid[key] = (entry.grid[key] || 0) + 1;
}

function addScroll(entry, scrollY, viewportHeight) {
  if (!viewportHeight) return;
  const bucket = clampCell((scrollY / viewportHeight) * GRID_SIZE);
  const key = gridKey(0, bucket);
  entry.grid[key] = (entry.grid[key] || 0) + 1;
}

function addEvents(projectId, url, deviceType, viewport, events) {
  const vw = viewport?.width || 0;
  const vh = viewport?.height || 0;
  const dev = deviceType || "desktop";

  events.forEach((ev) => {
    const data = ev.data || {};
    if (ev.type === "click" && data.x != null && data.y != null) {
      addClickOrAttention(ensureBufferKey(projectId, url, "click", dev), data.x, data.y, vw, vh);
      addClickOrAttention(ensureBufferKey(projectId, url, "click", "all"), data.x, data.y, vw, vh);
    } else if (ev.type === "scroll" && data.scrollY != null) {
      addScroll(ensureBufferKey(projectId, url, "scroll", dev), data.scrollY, vh);
      addScroll(ensureBufferKey(projectId, url, "scroll", "all"), data.scrollY, vh);
    } else if (ev.type === "mousemove" && data.x != null && data.y != null) {
      addClickOrAttention(ensureBufferKey(projectId, url, "attention", dev), data.x, data.y, vw, vh);
      addClickOrAttention(ensureBufferKey(projectId, url, "attention", "all"), data.x, data.y, vw, vh);
    }
  });
}

function flush() {
  if (buffer.size === 0) return;
  const toFlush = buffer;
  buffer = new Map();

  const ops = [];
  toFlush.forEach((entry) => {
    const inc = {};
    Object.keys(entry.grid).forEach((k) => {
      inc[`grid.${k}`] = entry.grid[k];
    });
    if (Object.keys(inc).length === 0) return;
    ops.push(
      Heatmap.findOneAndUpdate(
        {
          projectId: entry.projectId,
          url: entry.url,
          type: entry.type,
          deviceType: entry.deviceType
        },
        { $inc: inc, $set: { updatedAt: new Date() } },
        { upsert: true, new: true }
      )
    );
  });

  Promise.all(ops).catch((err) => {
    if (err) console.error("Heatmap flush error:", err.message);
  });
}

function startFlushInterval() {
  if (flushTimer) return;
  flushTimer = setInterval(flush, FLUSH_INTERVAL_MS);
  if (flushTimer.unref) flushTimer.unref();
}

startFlushInterval();

module.exports = { addEvents, flush, GRID_SIZE };
