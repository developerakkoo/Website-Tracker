(function() {
  'use strict';

  var API_BASE = window.__trackerBase || 'http://localhost:3000';
  var apiKey = window.__trackerKey;
  if (!apiKey) {
    return;
  }

  var sessionId = crypto.randomUUID();
  var sessionInitialized = false;
  var currentPageIndex = 0;
  var lastHref = '';
  var historyHooked = false;
  var eventQueue = [];
  var batchInterval = null;
  var lastMouseMoveTime = 0;
  var MOUSE_MOVE_THROTTLE = 100;
  var MAX_QUEUE_SIZE = 200;
  var BATCH_INTERVAL = 5000;

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

  function captureSnapshot() {
    try {
      var raw = document.documentElement.outerHTML;
      var snapshot = raw.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
      return fetch(API_BASE + '/api/session/capture', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: apiKey, sessionId: sessionId, snapshot: snapshot })
      });
    } catch (e) {
      return Promise.resolve();
    }
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
        if (!res.ok) return;
        currentPageIndex++;
        addEvent('navigation', { url: href });
        return captureSnapshot();
      })
      .catch(function() {});
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
        if (!res.ok) return;
        sessionInitialized = true;
        lastHref = window.location.href;
        currentPageIndex = 0;
        hookHistory();
        return captureSnapshot();
      })
      .catch(function() {});
  }

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
    } catch (e) {}
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

  function initialize() {
    try {
      sendInstallationPing();
      initSession();
      document.addEventListener('click', handleClick, true);
      window.addEventListener('scroll', handleScroll, true);
      document.addEventListener('mousemove', handleMouseMove, true);
      window.addEventListener('beforeunload', flushEvents);
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
