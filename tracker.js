(function() {
  'use strict';
  
  // Configuration
  var API_BASE = window.__trackerBase || 'http://localhost:3000';
  
  // Read apiKey from window.__trackerKey
  var apiKey = window.__trackerKey;
  if (!apiKey) {
    return;
  }
  
  // Generate sessionId
  var sessionId = crypto.randomUUID();
  var sessionInitialized = false;
  var eventQueue = [];
  var batchInterval = null;
  var lastMouseMoveTime = 0;
  var MOUSE_MOVE_THROTTLE = 100;
  var MAX_QUEUE_SIZE = 200;
  var BATCH_INTERVAL = 5000;
  
  // Helper: Send request silently
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
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(data),
        keepalive: true
      }).catch(function() {});
      
      return true;
    } catch (e) {
      return false;
    }
  }
  
  // Send installation ping immediately
  function sendInstallationPing() {
    try {
      sendRequest(API_BASE + '/api/installation/ping', {
        apiKey: apiKey,
        url: window.location.href
      });
    } catch (e) {}
  }
  
  // Initialize session
  function initSession() {
    if (sessionInitialized) {
      return;
    }
    
    try {
      var screen = {
        width: window.screen.width || 0,
        height: window.screen.height || 0
      };
      
      sendRequest(API_BASE + '/api/session/init', {
        apiKey: apiKey,
        sessionId: sessionId,
        url: window.location.href,
        userAgent: navigator.userAgent || '',
        screen: screen
      });
      
      sessionInitialized = true;
    } catch (e) {}
  }
  
  // Add event to queue
  function addEvent(type, data) {
    try {
      if (eventQueue.length >= MAX_QUEUE_SIZE) {
        eventQueue.shift();
      }
      
      eventQueue.push({
        type: type,
        data: data,
        timestamp: Date.now()
      });
    } catch (e) {}
  }
  
  // Send batched events
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
  
  // Flush events on page unload using sendBeacon
  function flushEvents() {
    if (eventQueue.length === 0 || !sessionInitialized) {
      return;
    }
    
    try {
      var eventsToSend = eventQueue.slice();
      sendRequest(API_BASE + '/api/session/events', {
        apiKey: apiKey,
        sessionId: sessionId,
        events: eventsToSend
      }, true);
    } catch (e) {}
  }
  
  // Event handlers
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
  
  // Initialize
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
  
  // Start immediately
  sendInstallationPing();
  
  // Initialize when DOM is ready
  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    initialize();
  } else {
    window.addEventListener('DOMContentLoaded', initialize);
  }
})();
