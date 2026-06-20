const TRACKER_PATHS = new Set([
  "/tracker.js",
  "/api/installation/ping",
  "/api/session/init",
  "/api/session/rrweb-chunk",
  "/api/session/events",
  "/api/session/capture",
  "/api/session/end",
  "/api/session/recording-status",
  "/api/session/page"
]);

const VERBOSE = process.env.TRACKER_DEBUG === "1";

function truncate(value, max) {
  if (!value || typeof value !== "string") return "";
  return value.length <= max ? value : value.slice(0, max) + "…";
}

function extractTrackerMeta(body) {
  if (!body || typeof body !== "object") return {};
  const sessionId = body.sessionId ? truncate(String(body.sessionId), VERBOSE ? 64 : 12) : "";
  const apiKey = body.apiKey ? truncate(String(body.apiKey), VERBOSE ? 64 : 16) : "";
  return { sessionId, apiKey };
}

function trackerRequestLogger(req, res, next) {
  const path = req.path || req.url.split("?")[0];
  if (!TRACKER_PATHS.has(path)) return next();

  const started = Date.now();
  const meta = extractTrackerMeta(req.body);
  const ip = req.ip || req.connection?.remoteAddress || "";

  console.info(
    `[WT-API] --> ${req.method} ${path} ip=${ip}` +
      (meta.sessionId ? ` sessionId=${meta.sessionId}` : "") +
      (meta.apiKey ? ` apiKey=${meta.apiKey}` : "")
  );

  res.on("finish", () => {
    const ms = Date.now() - started;
    const len = res.getHeader("content-length") || "-";
    console.info(`[WT-API] <-- ${req.method} ${path} ${res.statusCode} ms=${ms} bytes=${len}`);
  });

  next();
}

module.exports = trackerRequestLogger;
