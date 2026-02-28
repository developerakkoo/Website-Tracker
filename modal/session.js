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
  }

}, { timestamps: true });

module.exports = mongoose.model("Session", sessionSchema);
