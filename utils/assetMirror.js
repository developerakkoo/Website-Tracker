const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");

const MIRROR_DIR = path.join(__dirname, "..", "data", "mirror");
const MAX_ASSET_BYTES = 2 * 1024 * 1024;
const ALLOWED_CONTENT_TYPES = [
  "text/css",
  "font/",
  "image/",
  "application/font",
  "application/octet-stream"
];

function ensureMirrorDir() {
  if (!fs.existsSync(MIRROR_DIR)) {
    fs.mkdirSync(MIRROR_DIR, { recursive: true });
  }
}

function hashUrl(url) {
  return crypto.createHash("sha256").update(String(url)).digest("hex").slice(0, 32);
}

function isAllowedContentType(contentType) {
  if (!contentType) return false;
  const ct = contentType.toLowerCase();
  return ALLOWED_CONTENT_TYPES.some((prefix) => ct.startsWith(prefix));
}

function fetchRemoteAsset(url) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (e) {
      reject(new Error("invalid url"));
      return;
    }
    if (!["http:", "https:"].includes(parsed.protocol)) {
      reject(new Error("unsupported protocol"));
      return;
    }

    const lib = parsed.protocol === "https:" ? https : http;
    const req = lib.get(
      url,
      {
        timeout: 10000,
        headers: { "User-Agent": "WebsiteTracker-Mirror/1.0" }
      },
      (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          fetchRemoteAsset(new URL(res.headers.location, url).href).then(resolve).catch(reject);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`status ${res.statusCode}`));
          return;
        }
        const contentType = res.headers["content-type"] || "application/octet-stream";
        if (!isAllowedContentType(contentType)) {
          reject(new Error("content type not allowed"));
          return;
        }
        const chunks = [];
        let total = 0;
        res.on("data", (chunk) => {
          total += chunk.length;
          if (total > MAX_ASSET_BYTES) {
            req.destroy();
            reject(new Error("asset too large"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          resolve({
            buffer: Buffer.concat(chunks),
            contentType
          });
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("timeout"));
    });
  });
}

async function mirrorAsset(url) {
  ensureMirrorDir();
  const hash = hashUrl(url);
  const metaPath = path.join(MIRROR_DIR, `${hash}.meta.json`);
  const dataPath = path.join(MIRROR_DIR, `${hash}.bin`);

  if (fs.existsSync(dataPath) && fs.existsSync(metaPath)) {
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    return { hash, contentType: meta.contentType, cached: true };
  }

  const { buffer, contentType } = await fetchRemoteAsset(url);
  fs.writeFileSync(dataPath, buffer);
  fs.writeFileSync(
    metaPath,
    JSON.stringify({ url, contentType, bytes: buffer.length, mirroredAt: new Date().toISOString() })
  );
  return { hash, contentType, cached: false };
}

function getMirroredAsset(hash) {
  const safe = String(hash).replace(/[^a-f0-9]/gi, "").slice(0, 32);
  const metaPath = path.join(MIRROR_DIR, `${safe}.meta.json`);
  const dataPath = path.join(MIRROR_DIR, `${safe}.bin`);
  if (!fs.existsSync(dataPath) || !fs.existsSync(metaPath)) return null;
  const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
  return {
    buffer: fs.readFileSync(dataPath),
    contentType: meta.contentType || "application/octet-stream"
  };
}

module.exports = { mirrorAsset, getMirroredAsset, hashUrl, MIRROR_DIR };
