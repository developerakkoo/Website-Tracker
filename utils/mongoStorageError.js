/** MongoDB Atlas M0 storage quota — writes blocked (code 8000). */
function isMongoStorageQuotaError(err) {
  if (!err) return false;
  if (err.code === 8000 || err.codeName === "AtlasError") return true;
  const er = err.errorResponse;
  return !!(er && (er.code === 8000 || String(er.errmsg || "").includes("space quota")));
}

function storageQuotaResponse(res) {
  return res.status(503).json({
    ok: false,
    code: "storage_quota",
    message: "Database storage quota exceeded. Free space in MongoDB Atlas or upgrade tier."
  });
}

module.exports = { isMongoStorageQuotaError, storageQuotaResponse };
