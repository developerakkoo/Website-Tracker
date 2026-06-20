const mongoose = require("mongoose");

const eventSchema = new mongoose.Schema({

  sessionId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Session",
    required: true,
    index: true
  },

  type: {
    type: String,
    required: true
  },

  data: {
    type: mongoose.Schema.Types.Mixed,
    required: true
  },

  timestamp: {
    type: Number,
    required: true,
    index: true
  },

  pageIndex: {
    type: Number,
    default: 0,
    index: true
  },

  createdAt: {
    type: Date,
    default: Date.now
  }

}, { timestamps: false });

eventSchema.index({ sessionId: 1, pageIndex: 1, timestamp: 1 });
eventSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 30 });

module.exports = mongoose.model("Event", eventSchema);
