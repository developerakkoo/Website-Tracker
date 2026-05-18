const GOAL_KEY_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const MAX_GOALS_PER_PROJECT = 20;

function isValidGoalKey(key) {
  return typeof key === "string" && GOAL_KEY_RE.test(key);
}

function sanitizeSelector(selector) {
  if (!selector || typeof selector !== "string") return "";
  const s = selector.trim().slice(0, 200);
  if (!s) return "";
  const lower = s.toLowerCase();
  if (lower.includes("javascript:") || lower.includes(":has(")) {
    return null;
  }
  return s;
}

function normalizeGoalKey(key) {
  if (typeof key !== "string") return null;
  const k = key.trim().toLowerCase();
  return isValidGoalKey(k) ? k : null;
}

function utcDateKey(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

function urlMatchesPattern(url, pattern) {
  if (!pattern || !pattern.trim()) return true;
  const p = pattern.trim();
  try {
    const u = new URL(url || "");
    const path = u.pathname + u.search;
    if (p.startsWith("http://") || p.startsWith("https://")) {
      return url.startsWith(p) || url.includes(p);
    }
    return path.startsWith(p) || path.includes(p);
  } catch {
    return (url || "").includes(p);
  }
}

const WHATSAPP_TEMPLATE = {
  key: "whatsapp",
  name: "WhatsApp button",
  selector: 'a[href*="wa.me"], a[href*="api.whatsapp.com"], a[href*="whatsapp.com"]',
  urlPattern: ""
};

module.exports = {
  GOAL_KEY_RE,
  MAX_GOALS_PER_PROJECT,
  isValidGoalKey,
  sanitizeSelector,
  normalizeGoalKey,
  utcDateKey,
  urlMatchesPattern,
  WHATSAPP_TEMPLATE
};
