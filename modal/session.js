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

  pages: [
    {
      url: String,
      snapshot: { type: String, default: "" },
      startedAt: Date,
      viewport: {
        width: Number,
        height: Number
      },
      eventsCount: { type: Number, default: 0 }
    }
  ]

}, { timestamps: true });

sessionSchema.index({ sessionId: 1, "pages.startedAt": 1 });

module.exports = mongoose.model("Session", sessionSchema);
