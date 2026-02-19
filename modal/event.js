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
  }

}, { timestamps: false });

module.exports = mongoose.model("Event", eventSchema);
