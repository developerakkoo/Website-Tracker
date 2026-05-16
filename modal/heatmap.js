const mongoose = require("mongoose");

const heatmapSchema = new mongoose.Schema(
  {
    projectId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Project",
      required: true,
      index: true
    },
    url: { type: String, required: true, index: true },
    type: { type: String, required: true, enum: ["click", "scroll", "attention"], index: true },
    deviceType: { type: String, default: "all", index: true },
    grid: { type: mongoose.Schema.Types.Mixed, default: {} },
    updatedAt: { type: Date, default: Date.now, index: true }
  },
  { timestamps: false }
);

heatmapSchema.index({ projectId: 1, url: 1, type: 1, deviceType: 1 }, { unique: true });

module.exports = mongoose.model("Heatmap", heatmapSchema);
