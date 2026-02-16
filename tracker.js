(function () {
  const sessionId = localStorage.getItem("sessionId") || crypto.randomUUID();
  localStorage.setItem("sessionId", sessionId);

  function sendEvent(type, data) {
    fetch("http://localhost:3000/track", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        sessionId,
        event: {
          type,
          data,
          timestamp: Date.now(),
        },
      }),
    });
  }

  document.addEventListener("click", (e) => {
    sendEvent("click", {
      x: e.clientX,
      y: e.clientY,
    });
  });

  document.addEventListener("scroll", () => {
    sendEvent("scroll", {
      scrollY: window.scrollY,
    });
  });

})();
