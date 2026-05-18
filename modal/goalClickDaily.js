const mongoose = require("mongoose");

const goalClickDailySchema = new mongoose.Schema(
  {
    projectId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Project",
      required: true,
      index: true
    },
    goalKey: {
      type: String,
      required: true,
      index: true
    },
    date: {
      type: String,
      required: true,
      index: true
    },
    clicks: {
      type: Number,
      default: 0
    },
    uniqueSessions: {
      type: Number,
      default: 0
    }
  },
  { timestamps: false }
);

goalClickDailySchema.index({ projectId: 1, goalKey: 1, date: 1 }, { unique: true });

module.exports = mongoose.model("GoalClickDaily", goalClickDailySchema);
