/**
 * Delete sessions and events older than RETENTION_DAYS (default 30).
 * Usage: node scripts/cleanup-old-data.js
 * Optional: RETENTION_DAYS=14 DRY_RUN=1 node scripts/cleanup-old-data.js
 */
require("dotenv").config();
const mongoose = require("mongoose");
const Session = require("../modal/session");
const Event = require("../modal/event");

const RETENTION_DAYS = parseInt(process.env.RETENTION_DAYS || "30", 10);
const DRY_RUN = process.env.DRY_RUN === "1";

async function main() {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) {
    console.error("Set MONGO_URI in .env");
    process.exit(1);
  }

  await mongoose.connect(uri);
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
  console.log(`Cutoff: ${cutoff.toISOString()} (${RETENTION_DAYS} days)`);

  const oldSessions = await Session.find({ startedAt: { $lt: cutoff } }, { _id: 1 }).lean();
  const sessionIds = oldSessions.map((s) => s._id);

  if (DRY_RUN) {
    const eventCount = sessionIds.length
      ? await Event.countDocuments({ sessionId: { $in: sessionIds } })
      : 0;
    console.log(`DRY_RUN: would delete ${oldSessions.length} sessions, ~${eventCount} events`);
    await mongoose.disconnect();
    return;
  }

  let eventsDeleted = 0;
  if (sessionIds.length) {
    const er = await Event.deleteMany({ sessionId: { $in: sessionIds } });
    eventsDeleted = er.deletedCount || 0;
  }
  const sr = await Session.deleteMany({ startedAt: { $lt: cutoff } });

  console.log(`Deleted ${sr.deletedCount || 0} sessions, ${eventsDeleted} events`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
