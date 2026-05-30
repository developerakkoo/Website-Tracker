const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;

function stripScripts(html) {
  return html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
}

function stripUnsafeAttrs(html) {
  return html
    .replace(/\s+on\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\s+integrity\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
}

function normalizeSnapshot(snapshot) {
  let s = stripUnsafeAttrs(stripScripts(snapshot || ''));
  if (s.length > MAX_SNAPSHOT_BYTES) s = s.slice(0, MAX_SNAPSHOT_BYTES);
  return s;
}

module.exports = { normalizeSnapshot, MAX_SNAPSHOT_BYTES };
