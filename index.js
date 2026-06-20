require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const connectDB = require("./utils/db");
const trackerRequestLogger = require("./middleware/trackerRequestLogger");

//Routes
const authRoutes = require('./routes/authRoute');
const projectRoutes = require('./routes/projectRoute');
const installationRoutes = require('./routes/installationRoute');
const sessionRoutes = require('./routes/sessionRoute');
const trackerRoutes = require('./routes/trackerRoute');
const goalRoutes = require('./routes/goalRoute');



connectDB();
const app = express();
// Reflect request origin (required when tracker uses sendBeacon same-origin, or credentials)
app.use(cors({
  origin: true,
  credentials: true,
  methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
// Tracker payloads (snapshots, rrweb chunks) can exceed default 100kb limit
const TRACKER_BODY_LIMIT = "15mb";
app.use(bodyParser.json({ limit: TRACKER_BODY_LIMIT }));
app.use(trackerRequestLogger);

const PORT = process.env.PORT || 3000;

app.use("/demo-mp", express.static(__dirname + "/demo-mp"));

app.use("/api/auth", authRoutes);
app.use("/api/projects", projectRoutes);
app.use("/api/installation", installationRoutes);
app.use("/api", sessionRoutes);
app.use("/api/tracker", trackerRoutes);
app.use("/api/projects/:id/goals", goalRoutes);

let cachedTrackerJs = null;
const buildMetaPath = path.join(__dirname, "public", "tracker-build-meta.json");

function loadBuildMeta() {
  try {
    if (fs.existsSync(buildMetaPath)) {
      return JSON.parse(fs.readFileSync(buildMetaPath, "utf8"));
    }
  } catch (e) {}
  return { version: "1.0.3", mode: "rrweb-default", builtAt: null };
}

function loadTrackerJs() {
  const fullPath = path.join(__dirname, "public", "tracker.js");
  if (fs.existsSync(fullPath)) {
    cachedTrackerJs = fs.readFileSync(fullPath, "utf8");
    return cachedTrackerJs;
  }
  const builder = fs.readFileSync(path.join(__dirname, "utils/snapshotBuilder.js"), "utf8");
  const bundlePath = path.join(__dirname, "public", "tracker.bundle.js");
  let tracker = "";
  if (fs.existsSync(bundlePath)) {
    tracker = fs.readFileSync(bundlePath, "utf8");
  } else {
    tracker = fs.readFileSync(path.join(__dirname, "tracker.js"), "utf8");
  }
  cachedTrackerJs = builder + "\n" + tracker;
  return cachedTrackerJs;
}

loadTrackerJs();

// Serve prebuilt tracker.js (snapshot builder + bundled rrweb tracker)
app.get("/tracker.js", (req, res) => {
  if (!cachedTrackerJs) loadTrackerJs();
  res.setHeader("Content-Type", "application/javascript; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.send(cachedTrackerJs);
});

app.get("/tracker-version", (req, res) => {
  res.json(loadBuildMeta());
});

if (process.env.TRACKER_DEBUG === "1") {
  app.get("/api/debug/tracker-ping", (req, res) => {
    res.json({
      ok: true,
      mongo: mongoose.connection.readyState === 1 ? "connected" : "disconnected",
      time: new Date().toISOString(),
      tracker: loadBuildMeta()
    });
  });
}

// Local demo page for testing tracker installation and sessions
app.get("/demo", (req, res) => {
  res.sendFile(__dirname + "/home.html");
});

app.get("/version", (req, res) => {
  res.send("1.0.4");
});
app.listen(PORT, () => {
  const meta = loadBuildMeta();
  console.log(`API listening on port ${PORT}`);
  console.log(`  Tracker build:  v${meta.version} ${meta.builtAt || "unknown"}`);
  console.log(`  Dashboard API:  http://localhost:${PORT}/api`);
  console.log(`  Tracker script: http://localhost:${PORT}/tracker.js`);
  console.log(`  Demo page:      http://localhost:${PORT}/demo`);
  console.log(`  Multi-page demo:http://localhost:${PORT}/demo-mp/`);
  if (process.env.TRACKER_DEBUG === "1") {
    console.log(`  Tracker debug:  TRACKER_DEBUG=1 (request logging verbose)`);
  }
});
