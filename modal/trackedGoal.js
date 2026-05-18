const mongoose = require("mongoose");

const trackedGoalSchema = new mongoose.Schema(
  {
    projectId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Project",
      required: true,
      index: true
    },
    key: {
      type: String,
      required: true,
      trim: true,
      maxlength: 64
    },
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 120
    },
    selector: {
      type: String,
      default: "",
      maxlength: 200
    },
    urlPattern: {
      type: String,
      default: "",
      maxlength: 500
    },
    enabled: {
      type: Boolean,
      default: true
    }
  },
  { timestamps: true }
);

trackedGoalSchema.index({ projectId: 1, key: 1 }, { unique: true });

module.exports = mongoose.model("TrackedGoal", trackedGoalSchema);
