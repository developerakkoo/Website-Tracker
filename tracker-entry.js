import { record } from 'rrweb';

(function () {
  'use strict';

  var API_BASE = window.__trackerBase || 'http://localhost:3000';
  var apiKey = window.__trackerKey;
  if (!apiKey) return;

  if (localStorage.getItem('wt_opt_out') === '1') return;

  var SESSION_TTL_MS = 30 * 60 * 1000;
  var CHUNK_INTERVAL_MS = 3000;
  var BATCH_INTERVAL = 3000;
  var sessionInitialized = false;
  var initRetried = false;
  var quotaBlocked = false;
  var currentPageIndex = 0;
  var lastHref = '';
  var historyHooked = false;
  var eventQueue = [];
  var batchInterval = null;
  var chunkInterval = null;
  var GOAL_KEY_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
  var GOAL_DEDUPE_MS = 2000;
  var MAX_GOAL_CLICKS_PER_SESSION = 50;
  var configuredGoals = [];
  var lastGoalClickByKey = {};
  var goalClickCount = 0;

  var stopRecording = null;
  var rrwebBuffer = [];
  var chunkIndex = 0;
  var lastSnapshotBytes = 0;
  var lastCaptureSuccess = false;
  var captureTimers = [];

  var DB_NAME = 'wt_offline';
  var STORE = 'chunks';
  var MAX_CHUNK_JSON_BYTES = 3 * 1024 * 1024;
  var KEEPALIVE_MAX_BYTES = 60000;
  var UPLOAD_TIMEOUT_MS = 120000;
  var RRWEB_FULL_SNAPSHOT = 2;
  var uploadQueue = Promise.resolve();

  window.__tracker = {
    optOut: function () {
      localStorage.setItem('wt_opt_out', '1');
      if (typeof stopRecording === 'function') stopRecording();
      stopRecording = null;
      rrwebBuffer = [];
      eventQueue = [];
    },
    optIn: function () {
      localStorage.removeItem('wt_opt_out');
    }
  };

  function storageKeys() {
    var prefix = 'wt_' + String(apiKey).slice(0, 16).replace(/[^a-zA-Z0-9]/g, '');
    return { sid: prefix + '_sid', exp: prefix + '_exp' };
  }

  function touchSessionExpiry() {
    try {
      var keys = storageKeys();
      sessionStorage.setItem(keys.exp, String(Date.now() + SESSION_TTL_MS));
    } catch (e) {}
  }

  function loadPersistedSessionId() {
    try {
      var keys = storageKeys();
      var sid = sessionStorage.getItem(keys.sid);
      var exp = parseInt(sessionStorage.getItem(keys.exp) || '0', 10);
      if (sid && exp && Date.now() < exp) return sid;
    } catch (e) {}
    return null;
  }

  function persistSession(id) {
    try {
      var keys = storageKeys();
      sessionStorage.setItem(keys.sid, id);
      sessionStorage.setItem(keys.exp, String(Date.now() + SESSION_TTL_MS));
    } catch (e) {}
  }

  function clearPersistedSession() {
    try {
      var keys = storageKeys();
      sessionStorage.removeItem(keys.sid);
      sessionStorage.removeItem(keys.exp);
    } catch (e) {}
  }

  var sessionId = loadPersistedSessionId();
  if (!sessionId) {
    sessionId = crypto.randomUUID();
    persistSession(sessionId);
  }

  function isTrackerUrl(url) {
    if (!url) return false;
    try {
      return String(url).indexOf(API_BASE) === 0;
    } catch (e) {
      return false;
    }
  }

  /** sendBeacon uses credentials:include cross-origin — incompatible with ACAO:* */
  function isCrossOriginApi() {
    try {
      return new URL(API_BASE).origin !== window.location.origin;
    } catch (e) {
      return true;
    }
  }

  function trackerFetchOpts(body, options) {
    options = options || {};
    var useKeepalive = options.keepalive !== false;
    if (useKeepalive && body && body.length > KEEPALIVE_MAX_BYTES) {
      useKeepalive = false;
    }
    return {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body,
      keepalive: useKeepalive,
      credentials: 'omit'
    };
  }

  function fetchWithTimeout(url, opts, timeoutMs) {
    timeoutMs = timeoutMs || UPLOAD_TIMEOUT_MS;
    if (typeof AbortController === 'undefined') {
      return fetch(url, opts);
    }
    var controller = new AbortController();
    var timer = setTimeout(function () {
      controller.abort();
    }, timeoutMs);
    opts = Object.assign({}, opts, { signal: controller.signal });
    return fetch(url, opts).finally(function () {
      clearTimeout(timer);
    });
  }

  function trySendBeacon(url, payload) {
    if (!navigator.sendBeacon || isCrossOriginApi()) return false;
    try {
      var blob = new Blob([payload], { type: 'application/json' });
      return navigator.sendBeacon(url, blob);
    } catch (e) {
      return false;
    }
  }

  function openDb() {
    return new Promise(function (res, rej) {
      var req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function (e) {
        e.target.result.createObjectStore(STORE, { autoIncrement: true });
      };
      req.onsuccess = function (e) {
        res(e.target.result);
      };
      req.onerror = rej;
    });
  }

  function sendChunk(chunk, attempt) {
    attempt = attempt || 0;
    var MAX_RETRIES = 3;
    var endpoint = API_BASE + '/api/session/rrweb-chunk';
    var payload = JSON.stringify(chunk);
    try {
      if (trySendBeacon(endpoint, payload)) return Promise.resolve(true);
      return fetchWithTimeout(endpoint, trackerFetchOpts(payload, { keepalive: false })).then(function (res) {
        if (!res.ok) {
          wtWarn('Chunk upload failed: HTTP ' + res.status);
        }
        return res.ok;
      }).catch(function (err) {
        if (err && err.name === 'AbortError') {
          wtWarn('Chunk upload timed out after ' + (UPLOAD_TIMEOUT_MS / 1000) + 's');
        } else {
          wtWarn('Chunk upload network error');
        }
        if (attempt < MAX_RETRIES) {
          return new Promise(function (r) {
            setTimeout(r, 1000 * Math.pow(2, attempt));
          }).then(function () {
            return sendChunk(chunk, attempt + 1);
          });
        }
        return false;
      });
    } catch (e) {
      return Promise.resolve(false);
    }
  }

  function enqueueChunk(chunk) {
    uploadQueue = uploadQueue.then(function () {
      return sendChunk(chunk).then(function (sent) {
        if (!sent) {
          return openDb().then(function (db) {
            return new Promise(function (resolve, reject) {
              var tx = db.transaction(STORE, 'readwrite');
              tx.objectStore(STORE).add(chunk);
              tx.oncomplete = function () {
                resolve();
              };
              tx.onerror = reject;
            });
          });
        }
      });
    });
    return uploadQueue;
  }

  function replayOfflineChunks() {
    return openDb().then(function (db) {
      return new Promise(function (resolve) {
        var tx = db.transaction(STORE, 'readwrite');
        var store = tx.objectStore(STORE);
        var req = store.getAll();
        req.onsuccess = function () {
          var items = req.result || [];
          var keys = req.result ? [] : [];
          var getAllKeys = store.getAllKeys ? store.getAllKeys() : null;
          if (getAllKeys) {
            getAllKeys.onsuccess = function () {
              keys = getAllKeys.result || [];
              drain();
            };
          } else {
            drain();
          }
          function drain() {
            var chain = Promise.resolve();
            items.forEach(function (chunk, i) {
              chain = chain.then(function () {
                return sendChunk(chunk).then(function (sent) {
                  if (sent && keys[i] != null) store.delete(keys[i]);
                });
              });
            });
            chain.then(resolve);
          }
        };
        req.onerror = function () {
          resolve();
        };
      });
    }).catch(function () {});
  }

  function handleRrwebEvent(event, isCheckout) {
    rrwebBuffer.push(event);
    if (event && event.type === RRWEB_FULL_SNAPSHOT && chunkIndex === 0) {
      flushRrwebChunk(true);
      return;
    }
    if (isCheckout) flushRrwebChunk(true);
  }

  function postChunkPayload(payloadObj, isCheckout) {
    var payload = JSON.stringify(payloadObj);

    return compressPayload(payload).then(function (compressed) {
      if (compressed) {
        return enqueueChunk({
          apiKey: apiKey,
          sessionId: sessionId,
          chunkIndex: payloadObj.chunkIndex,
          isCheckout: isCheckout,
          recordedAt: payloadObj.recordedAt,
          body: compressed.body,
          encoding: compressed.encoding
        });
      }
      return enqueueChunk({
        apiKey: apiKey,
        sessionId: sessionId,
        chunkIndex: payloadObj.chunkIndex,
        isCheckout: isCheckout,
        recordedAt: payloadObj.recordedAt,
        events: payloadObj.events,
        encoding: 'identity'
      });
    });
  }

  function flushEventsList(events, isCheckout) {
    if (events.length === 0 || !sessionInitialized) return Promise.resolve();

    chunkIndex += 1;
    var payloadObj = {
      apiKey: apiKey,
      sessionId: sessionId,
      chunkIndex: chunkIndex,
      isCheckout: isCheckout,
      recordedAt: Date.now(),
      events: events
    };

    if (JSON.stringify(payloadObj).length > MAX_CHUNK_JSON_BYTES && events.length > 1) {
      chunkIndex -= 1;
      var mid = Math.ceil(events.length / 2);
      return flushEventsList(events.slice(0, mid), isCheckout).then(function () {
        return flushEventsList(events.slice(mid), false);
      });
    }

    return postChunkPayload(payloadObj, isCheckout);
  }

  function flushRrwebChunk(isCheckout) {
    isCheckout = !!isCheckout;
    if (rrwebBuffer.length === 0 || !sessionInitialized) return Promise.resolve();
    var events = rrwebBuffer.splice(0);
    return flushEventsList(events, isCheckout);
  }

  function compressPayload(payload) {
    if (typeof CompressionStream === 'undefined') {
      return Promise.resolve(null);
    }
    try {
      var cs = new CompressionStream('gzip');
      var writer = cs.writable.getWriter();
      var reader = cs.readable.getReader();
      writer.write(new TextEncoder().encode(payload));
      writer.close();
      var chunks = [];
      function read() {
        return reader.read().then(function (result) {
          if (result.done) {
            var total = chunks.reduce(function (a, c) {
              return a + c.length;
            }, 0);
            var compressed = new Uint8Array(total);
            var offset = 0;
            chunks.forEach(function (c) {
              compressed.set(c, offset);
              offset += c.length;
            });
            var binary = '';
            for (var i = 0; i < compressed.length; i++) {
              binary += String.fromCharCode(compressed[i]);
            }
            return { body: btoa(binary), encoding: 'gzip' };
          }
          chunks.push(result.value);
          return read();
        });
      }
      return read().catch(function () {
        return null;
      });
    } catch (e) {
      return Promise.resolve(null);
    }
  }

  function applyBlockClasses() {
    try {
      document.querySelectorAll('[data-wt-block]').forEach(function (el) {
        el.classList.add('wt-no-record');
      });
    } catch (e) {}
  }

  function startRrweb() {
    if (stopRecording) return;
    applyBlockClasses();
    stopRecording = record({
      emit: function (event, isCheckout) {
        handleRrwebEvent(event, isCheckout);
      },
      checkoutEveryNth: 150,
      checkoutEveryNms: 25000,
      maskAllInputs: true,
      maskInputOptions: { password: true, email: true, tel: true, creditCard: true },
      blockClass: 'wt-no-record',
      maskTextSelector: '[data-wt-mask]',
      recordCanvas: false,
      collectFonts: false,
      inlineImages: false,
      inlineStylesheet: true,
      slimDOMOptions: 'all',
      sampling: {
        mousemove: 50,
        scroll: 100,
        input: 'last'
      }
    });
    setTimeout(function () {
      flushRrwebChunk(true);
    }, 500);
  }

  function sendRequest(url, data, useBeacon) {
    try {
      var payload = JSON.stringify(data);
      if (useBeacon && trySendBeacon(url, payload)) return true;
      fetch(url, trackerFetchOpts(payload)).catch(function () {});
      return true;
    } catch (e) {
      return false;
    }
  }

  function sendInstallationPing() {
    try {
      sendRequest(API_BASE + '/api/installation/ping', {
        apiKey: apiKey,
        url: window.location.href
      });
    } catch (e) {}
  }

  function buildSnapshotHtml() {
    try {
      if (typeof window.__wtBuildSnapshot === 'function') {
        return window.__wtBuildSnapshot();
      }
      var raw = document.documentElement.outerHTML;
      return raw.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
    } catch (e) {
      return '';
    }
  }

  function mirrorPageAssets() {
    try {
      var links = document.querySelectorAll('link[rel="stylesheet"][href]');
      for (var i = 0; i < links.length && i < 20; i++) {
        var href = links[i].href;
        if (!href || isTrackerUrl(href)) continue;
        fetch(API_BASE + '/api/session/mirror-asset', trackerFetchOpts(JSON.stringify({
          apiKey: apiKey,
          sessionId: sessionId,
          url: href
        }))).catch(function () {});
      }
    } catch (e) {}
  }

  function wtWarn(msg) {
    try {
      if (window.__trackerDebug || /localhost|127\.0\.0\.1/.test(window.location.hostname)) {
        console.warn('[WebsiteTracker]', msg);
      }
    } catch (e) {}
  }

  function sendCaptureSnapshot(snapshot, attempt) {
    attempt = attempt || 0;
    var MAX_RETRIES = 3;
    var payloadObj = { apiKey: apiKey, sessionId: sessionId, snapshot: snapshot };
    var payload = JSON.stringify(payloadObj);

    return compressPayload(payload).then(function (compressed) {
      var body;
      if (compressed) {
        body = JSON.stringify({
          apiKey: apiKey,
          sessionId: sessionId,
          body: compressed.body,
          encoding: compressed.encoding
        });
      } else {
        body = payload;
      }

      return fetchWithTimeout(API_BASE + '/api/session/capture', trackerFetchOpts(body, { keepalive: false }))
        .then(function (res) {
          return res.json().then(function (data) {
            return { ok: res.ok, data: data };
          }).catch(function () {
            return { ok: res.ok, data: {} };
          });
        })
        .then(function (result) {
          if (result.ok && result.data && (result.data.ok || result.data.success)) {
            if (result.data.skipped) return true;
            lastCaptureSuccess = true;
            lastSnapshotBytes = snapshot.length;
            mirrorPageAssets();
            return true;
          }
          if (attempt < MAX_RETRIES) {
            return new Promise(function (r) {
              setTimeout(r, 1000 * Math.pow(2, attempt));
            }).then(function () {
              return sendCaptureSnapshot(snapshot, attempt + 1);
            });
          }
          wtWarn('Snapshot capture failed after retries: ' + (result.data && result.data.code));
          return false;
        })
        .catch(function () {
          if (attempt < MAX_RETRIES) {
            return new Promise(function (r) {
              setTimeout(r, 1000 * Math.pow(2, attempt));
            }).then(function () {
              return sendCaptureSnapshot(snapshot, attempt + 1);
            });
          }
          wtWarn('Snapshot capture network error');
          return false;
        });
    });
  }

  function runCaptureSnapshot(force) {
    if (!sessionInitialized) return;
    try {
      var snapshot = buildSnapshotHtml();
      if (!snapshot) return;
      var bytes = snapshot.length;
      if (!force && lastCaptureSuccess && bytes <= lastSnapshotBytes * 1.05) return;
      sendCaptureSnapshot(snapshot, 0);
    } catch (e) {}
  }

  function scheduleCaptureSnapshot() {
    var start = function () {
      captureTimers.forEach(function (t) {
        clearTimeout(t);
      });
      captureTimers = [];

      var delays = [300, 2000, 5000];
      delays.forEach(function (delay) {
        captureTimers.push(
          setTimeout(function () {
            runCaptureSnapshot(false);
          }, delay)
        );
      });

      if (typeof requestIdleCallback === 'function') {
        requestIdleCallback(function () {
          runCaptureSnapshot(false);
        });
      } else {
        captureTimers.push(
          setTimeout(function () {
            runCaptureSnapshot(false);
          }, 8000)
        );
      }
    };

    if (document.readyState === 'complete') {
      start();
    } else {
      window.addEventListener('load', start, { once: true });
    }
  }

  function captureSnapshot() {
    scheduleCaptureSnapshot();
    runCaptureSnapshot(true);
    return Promise.resolve();
  }

  function hookHistory() {
    if (historyHooked) return;
    historyHooked = true;
    var origPush = history.pushState;
    var origReplace = history.replaceState;
    history.pushState = function () {
      origPush.apply(history, arguments);
      setTimeout(onSpaNavigation, 0);
    };
    history.replaceState = function () {
      origReplace.apply(history, arguments);
      setTimeout(onSpaNavigation, 0);
    };
    window.addEventListener('popstate', function () {
      setTimeout(onSpaNavigation, 0);
    });
    setInterval(function () {
      if (!sessionInitialized) return;
      try {
        var h = window.location.href;
        if (h !== lastHref) onSpaNavigation();
      } catch (e) {}
    }, 500);
  }

  function onSpaNavigation() {
    if (!sessionInitialized) return;
    var href = '';
    try {
      href = window.location.href;
    } catch (e) {
      return;
    }
    if (href === lastHref) return;
    lastHref = href;
    sendBatchedEvents();
    flushRrwebChunk(true);
    fetchGoals();
    touchSessionExpiry();
    var viewport = { width: window.innerWidth || 0, height: window.innerHeight || 0 };
    fetch(API_BASE + '/api/session/page', trackerFetchOpts(JSON.stringify({
      apiKey: apiKey,
      sessionId: sessionId,
      url: href,
      timestamp: Date.now(),
      viewport: viewport
    })))
      .then(function (res) {
        return res.json().then(function (data) {
          return { ok: res.ok, data: data };
        });
      })
      .then(function (result) {
        if (!result.ok) return;
        if (typeof result.data.pageIndex === 'number') {
          currentPageIndex = result.data.pageIndex;
        } else {
          currentPageIndex++;
        }
        addEvent('navigation', { url: href });
        return captureSnapshot();
      })
      .catch(function () {});
  }

  function handleInitSuccess(data) {
    sessionInitialized = true;
    touchSessionExpiry();
    persistSession(sessionId);
    lastHref = window.location.href;
    if (data && data.resumed) {
      currentPageIndex = typeof data.pageIndex === 'number' ? data.pageIndex : 0;
      if (data.newPage) addEvent('navigation', { url: lastHref });
    } else {
      currentPageIndex = typeof data.pageIndex === 'number' ? data.pageIndex : 0;
    }
    hookHistory();
    fetchGoals();
    startRrweb();
    captureSnapshot();
  }

  function initSession() {
    if (sessionInitialized || quotaBlocked) return;
    var screen = { width: window.screen.width || 0, height: window.screen.height || 0 };
    var viewport = { width: window.innerWidth || 0, height: window.innerHeight || 0 };
    fetch(API_BASE + '/api/session/init', trackerFetchOpts(JSON.stringify({
      apiKey: apiKey,
      sessionId: sessionId,
      url: window.location.href,
      userAgent: navigator.userAgent || '',
      screen: screen,
      viewport: viewport
    })))
      .then(function (res) {
        return res.json().then(function (data) {
          return { ok: res.ok, status: res.status, data: data };
        });
      })
      .then(function (result) {
        if (result.status === 429) {
          quotaBlocked = true;
          console.warn('[WebsiteTracker] Daily session quota reached. Recording stopped.');
          return;
        }
        if (result.status === 410 && result.data && result.data.expired && !initRetried) {
          clearPersistedSession();
          sessionId = crypto.randomUUID();
          persistSession(sessionId);
          initRetried = true;
          sessionInitialized = false;
          initSession();
          return;
        }
        if (!result.ok) return;
        handleInitSuccess(result.data);
      })
      .catch(function () {});
  }

  function fetchGoals() {
    try {
      fetch(API_BASE + '/api/tracker/goals?apiKey=' + encodeURIComponent(apiKey), {
        credentials: 'omit'
      })
        .then(function (res) {
          if (!res.ok) return;
          return res.json();
        })
        .then(function (data) {
          if (data && Array.isArray(data.goals)) configuredGoals = data.goals;
        })
        .catch(function () {});
    } catch (e) {}
  }

  function urlMatchesPattern(url, pattern) {
    if (!pattern || !String(pattern).trim()) return true;
    var p = String(pattern).trim();
    try {
      var u = new URL(url || '');
      var path = u.pathname + u.search;
      if (p.indexOf('http://') === 0 || p.indexOf('https://') === 0) return url.indexOf(p) !== -1;
      return path.indexOf(p) === 0 || path.indexOf(p) !== -1;
    } catch (err) {
      return (url || '').indexOf(p) !== -1;
    }
  }

  function isValidGoalKey(key) {
    return typeof key === 'string' && GOAL_KEY_RE.test(key);
  }

  function truncateText(text, max) {
    if (!text || typeof text !== 'string') return '';
    return text.length > max ? text.slice(0, max) : text;
  }

  function recordGoalClick(goalKey, goalName, el) {
    if (!isValidGoalKey(goalKey)) return;
    if (goalClickCount >= MAX_GOAL_CLICKS_PER_SESSION) return;
    var now = Date.now();
    var last = lastGoalClickByKey[goalKey] || 0;
    if (now - last < GOAL_DEDUPE_MS) return;
    lastGoalClickByKey[goalKey] = now;
    goalClickCount++;
    var tag = '';
    var text = '';
    try {
      if (el && el.tagName) tag = el.tagName;
      if (el && el.innerText) text = truncateText(el.innerText, 120);
    } catch (e) {}
    addEvent('goal_click', {
      goalKey: goalKey.toLowerCase(),
      goalName: goalName || '',
      pageUrl: window.location.href,
      elementTag: tag,
      elementText: text
    });
  }

  function trackGoalFromElement(el) {
    if (!el) return false;
    var attrEl = el.closest ? el.closest('[data-wt-goal]') : null;
    if (attrEl) {
      recordGoalClick(attrEl.getAttribute('data-wt-goal'), attrEl.getAttribute('data-wt-goal-label') || '', attrEl);
      return true;
    }
    return false;
  }

  function trackGoalFromSelectors(target) {
    if (!configuredGoals.length || !target) return false;
    var href = '';
    try {
      href = window.location.href;
    } catch (e) {
      return false;
    }
    for (var i = 0; i < configuredGoals.length; i++) {
      var g = configuredGoals[i];
      if (!g || !g.selector || !g.key) continue;
      if (!urlMatchesPattern(href, g.urlPattern)) continue;
      try {
        if (target.matches && target.matches(g.selector)) {
          recordGoalClick(g.key, g.name || '', target);
          return true;
        }
        if (target.closest && target.closest(g.selector)) {
          recordGoalClick(g.key, g.name || '', target.closest(g.selector));
          return true;
        }
      } catch (selErr) {}
    }
    return false;
  }

  window.__trackerTrackGoal = function (key, meta) {
    if (!isValidGoalKey(key)) return;
    var m = meta || {};
    recordGoalClick(key, m.goalName || m.label || '', null);
  };

  function addEvent(type, data) {
    try {
      if (eventQueue.length >= 200) eventQueue.shift();
      eventQueue.push({
        type: type,
        data: data,
        timestamp: Date.now(),
        pageIndex: currentPageIndex
      });
    } catch (e) {}
  }

  function sendBatchedEvents() {
    if (eventQueue.length === 0 || !sessionInitialized) return;
    try {
      var eventsToSend = eventQueue.slice();
      eventQueue = [];
      touchSessionExpiry();
      sendRequest(API_BASE + '/api/session/events', {
        apiKey: apiKey,
        sessionId: sessionId,
        events: eventsToSend
      });
    } catch (e) {}
  }

  function flushEvents() {
    sendBatchedEvents();
    flushRrwebChunk(true);
  }

  var clickMap = new Map();

  function reportSpecialEvent(type, e) {
    var selector = e.target.tagName ? e.target.tagName.toLowerCase() : 'element';
    if (e.target.id) selector += '#' + e.target.id;
    addEvent(type, {
      x: e.clientX,
      y: e.clientY,
      selector: selector
    });
  }

  function detectRageClick(e) {
    var key = (e.target.closest && e.target.closest('[id]') && e.target.closest('[id]').id) || e.target.tagName;
    var now = Date.now();
    var history = clickMap.get(key) || [];
    var recent = history.filter(function (t) {
      return now - t < 700;
    });
    recent.push(now);
    clickMap.set(key, recent);
    if (recent.length >= 3) {
      reportSpecialEvent('rage_click', e);
      clickMap.set(key, []);
    }
  }

  function detectDeadClick(e) {
    var snapshot = document.body ? document.body.innerHTML.length : 0;
    var url = location.href;
    setTimeout(function () {
      if (document.body && document.body.innerHTML.length === snapshot && location.href === url) {
        reportSpecialEvent('dead_click', e);
      }
    }, 750);
  }

  function handleClick(e) {
    try {
      detectRageClick(e);
      detectDeadClick(e);
      var target = e.target;
      if (!trackGoalFromElement(target)) trackGoalFromSelectors(target);
    } catch (err) {}
  }

  function handlePageHide() {
    flushEvents();
  }

  function handleVisibilityChange() {
    if (document.visibilityState === 'hidden') flushEvents();
  }

  function installConsoleCapture() {
    ['log', 'warn', 'error', 'info'].forEach(function (level) {
      var orig = console[level].bind(console);
      console[level] = function () {
        orig.apply(console, arguments);
        try {
          var message = Array.prototype.slice.call(arguments).map(String).slice(0, 3).join(' ').slice(0, 500);
          addEvent('console', { level: level, message: message });
        } catch (e) {}
      };
    });
  }

  function installNetworkCapture() {
    var origOpen = XMLHttpRequest.prototype.open;
    var origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) {
      this._wtMeta = { method: method, url: String(url).split('?')[0], start: 0 };
      return origOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function () {
      if (this._wtMeta) this._wtMeta.start = Date.now();
      this.addEventListener('loadend', function () {
        if (!this._wtMeta || isTrackerUrl(this._wtMeta.url)) return;
        addEvent('network', {
          method: this._wtMeta.method,
          url: this._wtMeta.url,
          status: this.status,
          duration: Date.now() - this._wtMeta.start,
          error: this.status === 0
        });
      });
      return origSend.apply(this, arguments);
    };

    var origFetch = window.fetch;
    window.fetch = function (input, init) {
      var start = Date.now();
      var urlStr = typeof input === 'string' ? input : input.url;
      var url = urlStr.split('?')[0];
      var method = ((init && init.method) || 'GET').toUpperCase();
      if (isTrackerUrl(url)) return origFetch.apply(this, arguments);
      return origFetch.apply(this, arguments).then(function (res) {
        addEvent('network', {
          method: method,
          url: url,
          status: res.status,
          duration: Date.now() - start,
          error: false
        });
        return res;
      }).catch(function (err) {
        addEvent('network', {
          method: method,
          url: url,
          status: 0,
          duration: Date.now() - start,
          error: true
        });
        throw err;
      });
    };
  }

  function initialize() {
    try {
      installConsoleCapture();
      installNetworkCapture();
      sendInstallationPing();
      initSession();
      document.addEventListener('click', handleClick, true);
      window.addEventListener('beforeunload', flushEvents);
      window.addEventListener('pagehide', handlePageHide);
      document.addEventListener('visibilitychange', handleVisibilityChange);
      batchInterval = setInterval(sendBatchedEvents, BATCH_INTERVAL);
      chunkInterval = setInterval(function () {
        flushRrwebChunk(false);
      }, CHUNK_INTERVAL_MS);
    } catch (e) {}
  }

  replayOfflineChunks().finally(function () {
    sendInstallationPing();
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
      initialize();
    } else {
      window.addEventListener('DOMContentLoaded', initialize);
    }
  });
})();
