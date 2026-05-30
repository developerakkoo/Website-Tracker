const mongoose = require("mongoose");

const sessionSchema = new mongoose.Schema({
  projectId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Project",
    required: true,
    index: true
  },

  sessionId: {
    type: String,
    required: true,
    index: true
  },

  url: String,

  userAgent: String,

  ipAddress: String,

  screen: {
    width: Number,
    height: Number
  },

  viewport: {
    width: Number,
    height: Number
  },

  deviceType: String,

  startedAt: {
    type: Date,
    default: Date.now,
    index: true
  },

  lastActivity: {
    type: Date,
    default: Date.now
  },

  duration: {
    type: Number,
    default: 0
  },

  eventCount: {
    type: Number,
    default: 0
  },

  snapshot: {
    type: String
  },

  hasRrweb: { type: Boolean, default: false },
  rrwebChunkCount: { type: Number, default: 0 },
  rrwebStatus: {
    type: String,
    enum: ["none", "partial", "complete"],
    default: "none"
  },
  rageClickCount: { type: Number, default: 0 },
  deadClickCount: { type: Number, default: 0 },
  errorCount: { type: Number, default: 0 },
  networkErrorCount: { type: Number, default: 0 },
  starred: { type: Boolean, default: false },
  tags: { type: [String], default: [] },

  pages: [
    {
      url: String,
      snapshot: { type: String, default: "" },
      startedAt: Date,
      viewport: {
        width: Number,
        height: Number
      },
      eventsCount: { type: Number, default: 0 },
      baseUrl: String,
      snapshotBytes: { type: Number, default: 0 },
      snapshotCapturedAt: Date
    }
  ]

}, { timestamps: true });

sessionSchema.index({ sessionId: 1, "pages.startedAt": 1 });
sessionSchema.index({ startedAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 90 });

module.exports = mongoose.model("Session", sessionSchema);
