(function() {
  'use strict';

  var API_BASE = window.__trackerBase || 'http://localhost:3000';
  var apiKey = window.__trackerKey;
  if (!apiKey) {
    return;
  }

  var SESSION_TTL_MS = 30 * 60 * 1000;
  var sessionInitialized = false;
  var initRetried = false;
  var currentPageIndex = 0;
  var lastHref = '';
  var historyHooked = false;
  var eventQueue = [];
  var batchInterval = null;
  var lastMouseMoveTime = 0;
  var MOUSE_MOVE_THROTTLE = 100;
  var MAX_QUEUE_SIZE = 200;
  var BATCH_INTERVAL = 5000;
  var GOAL_KEY_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
  var GOAL_DEDUPE_MS = 2000;
  var MAX_GOAL_CLICKS_PER_SESSION = 50;
  var configuredGoals = [];
  var lastGoalClickByKey = {};
  var goalClickCount = 0;

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
      if (sid && exp && Date.now() < exp) {
        return sid;
      }
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

  function sendRequest(url, data, useBeacon) {
    try {
      if (useBeacon && navigator.sendBeacon) {
        var blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
        return navigator.sendBeacon(url, blob);
      }
      if (useBeacon) {
        return false;
      }
      fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
        keepalive: true
      }).catch(function() {});
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

  function scheduleCaptureSnapshot() {
    var run = function() {
      try {
        var snapshot = buildSnapshotHtml();
        if (!snapshot) return;
        fetch(API_BASE + '/api/session/capture', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ apiKey: apiKey, sessionId: sessionId, snapshot: snapshot })
        }).catch(function() {});
      } catch (e) {}
    };

    if (document.readyState === 'complete') {
      setTimeout(run, 300);
    } else {
      window.addEventListener('load', function() {
        setTimeout(run, 300);
      }, { once: true });
    }
  }

  function captureSnapshot() {
    scheduleCaptureSnapshot();
    return Promise.resolve();
  }

  function hookHistory() {
    if (historyHooked) return;
    historyHooked = true;

    var origPush = history.pushState;
    var origReplace = history.replaceState;

    history.pushState = function() {
      origPush.apply(history, arguments);
      setTimeout(onSpaNavigation, 0);
    };
    history.replaceState = function() {
      origReplace.apply(history, arguments);
      setTimeout(onSpaNavigation, 0);
    };

    window.addEventListener('popstate', function() {
      setTimeout(onSpaNavigation, 0);
    });

    setInterval(function() {
      if (!sessionInitialized) return;
      try {
        var h = window.location.href;
        if (h !== lastHref) {
          onSpaNavigation();
        }
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
    fetchGoals();
    touchSessionExpiry();

    var viewport = {
      width: window.innerWidth || 0,
      height: window.innerHeight || 0
    };

    fetch(API_BASE + '/api/session/page', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        apiKey: apiKey,
        sessionId: sessionId,
        url: href,
        timestamp: Date.now(),
        viewport: viewport
      })
    })
      .then(function(res) {
        return res.json().then(function(data) {
          return { ok: res.ok, data: data };
        });
      })
      .then(function(result) {
        if (!result.ok) return;
        if (typeof result.data.pageIndex === 'number') {
          currentPageIndex = result.data.pageIndex;
        } else {
          currentPageIndex++;
        }
        addEvent('navigation', { url: href });
        return captureSnapshot();
      })
      .catch(function() {});
  }

  function handleInitSuccess(data) {
    sessionInitialized = true;
    touchSessionExpiry();
    persistSession(sessionId);
    lastHref = window.location.href;

    if (data && data.resumed) {
      currentPageIndex = typeof data.pageIndex === 'number' ? data.pageIndex : 0;
      if (data.newPage) {
        addEvent('navigation', { url: lastHref });
      }
    } else {
      currentPageIndex = typeof data.pageIndex === 'number' ? data.pageIndex : 0;
    }

    hookHistory();
    fetchGoals();
    captureSnapshot();
  }

  function initSession() {
    if (sessionInitialized) {
      return;
    }

    var screen = {
      width: window.screen.width || 0,
      height: window.screen.height || 0
    };
    var viewport = {
      width: window.innerWidth || 0,
      height: window.innerHeight || 0
    };
    var payload = {
      apiKey: apiKey,
      sessionId: sessionId,
      url: window.location.href,
      userAgent: navigator.userAgent || '',
      screen: screen,
      viewport: viewport
    };

    fetch(API_BASE + '/api/session/init', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
      .then(function(res) {
        return res.json().then(function(data) {
          return { ok: res.ok, status: res.status, data: data };
        });
      })
      .then(function(result) {
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
      .catch(function() {});
  }

  function fetchGoals() {
    try {
      fetch(API_BASE + '/api/tracker/goals?apiKey=' + encodeURIComponent(apiKey))
        .then(function(res) {
          if (!res.ok) return;
          return res.json();
        })
        .then(function(data) {
          if (data && Array.isArray(data.goals)) {
            configuredGoals = data.goals;
          }
        })
        .catch(function() {});
    } catch (e) {}
  }

  function urlMatchesPattern(url, pattern) {
    if (!pattern || !String(pattern).trim()) return true;
    var p = String(pattern).trim();
    try {
      var u = new URL(url || '');
      var path = u.pathname + u.search;
      if (p.indexOf('http://') === 0 || p.indexOf('https://') === 0) {
        return url.indexOf(p) !== -1;
      }
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
      var key = attrEl.getAttribute('data-wt-goal');
      var label = attrEl.getAttribute('data-wt-goal-label') || '';
      recordGoalClick(key, label, attrEl);
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

  function trackGoal(key, meta) {
    if (!isValidGoalKey(key)) return;
    var m = meta || {};
    recordGoalClick(key, m.goalName || m.label || '', null);
  }

  window.__trackerTrackGoal = trackGoal;

  function addEvent(type, data) {
    try {
      if (eventQueue.length >= MAX_QUEUE_SIZE) {
        eventQueue.shift();
      }
      eventQueue.push({
        type: type,
        data: data,
        timestamp: Date.now(),
        pageIndex: currentPageIndex
      });
    } catch (e) {}
  }

  function sendBatchedEvents() {
    if (eventQueue.length === 0 || !sessionInitialized) {
      return;
    }
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
    if (eventQueue.length === 0 || !sessionInitialized) {
      return;
    }
    try {
      var eventsToSend = eventQueue.slice();
      eventQueue = [];
      sendRequest(
        API_BASE + '/api/session/events',
        {
          apiKey: apiKey,
          sessionId: sessionId,
          events: eventsToSend
        },
        true
      );
    } catch (e) {}
  }

  function handleClick(e) {
    try {
      addEvent('click', {
        x: e.clientX || 0,
        y: e.clientY || 0
      });
      var target = e.target;
      if (!trackGoalFromElement(target)) {
        trackGoalFromSelectors(target);
      }
    } catch (err) {}
  }

  function handleScroll() {
    try {
      addEvent('scroll', {
        scrollY: window.scrollY || 0
      });
    } catch (e) {}
  }

  function handleMouseMove(e) {
    try {
      var now = Date.now();
      if (now - lastMouseMoveTime < MOUSE_MOVE_THROTTLE) {
        return;
      }
      lastMouseMoveTime = now;
      addEvent('mousemove', {
        x: e.clientX || 0,
        y: e.clientY || 0
      });
    } catch (e) {}
  }

  function handlePageHide() {
    flushEvents();
  }

  function handleVisibilityChange() {
    if (document.visibilityState === 'hidden') {
      flushEvents();
    }
  }

  function initialize() {
    try {
      sendInstallationPing();
      initSession();
      document.addEventListener('click', handleClick, true);
      window.addEventListener('scroll', handleScroll, true);
      document.addEventListener('mousemove', handleMouseMove, true);
      window.addEventListener('beforeunload', flushEvents);
      window.addEventListener('pagehide', handlePageHide);
      document.addEventListener('visibilitychange', handleVisibilityChange);
      batchInterval = setInterval(sendBatchedEvents, BATCH_INTERVAL);
    } catch (e) {}
  }

  sendInstallationPing();

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    initialize();
  } else {
    window.addEventListener('DOMContentLoaded', initialize);
  }
})();
