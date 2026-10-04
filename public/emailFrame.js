// Bootstrap script for the sandboxed email body frame.
//
// The frame runs with `sandbox="allow-scripts"` and therefore has an opaque
// origin: the app cannot reach into the frame's document, and the frame cannot
// reach the app. Everything the frame needs to tell the app travels through
// postMessage.
//
// This file is served from the app's own origin on purpose. The inherited CSP
// is `script-src 'self'`, so this script runs while any script embedded in an
// email stays blocked even if it survives sanitization.

(function () {
  var LINK = "maish:link";
  var HEIGHT = "maish:height";
  var WHEEL = "maish:wheel";
  // A trackpad sends no "fingers lifted" event; this much silence ends a gesture.
  var GESTURE_IDLE_MS = 150;

  function send(message) {
    parent.postMessage(message, "*");
  }

  // Links must never navigate the frame — the app opens them in the browser.
  document.addEventListener("click", function (event) {
    var target = event.target;
    var anchor = target && target.closest ? target.closest("a") : null;
    if (!anchor) return;

    var url = anchor.getAttribute("href");
    if (!url) return;

    event.preventDefault();
    send({ type: LINK, url: anchor.href || url });
  });

  // True when an element between the pointer and the frame can still scroll
  // sideways in the direction of the wheel (a wide table, a code block).
  function scrollsSideways(node, deltaX) {
    for (; node && node.nodeType === 1; node = node.parentElement) {
      var overflowX = getComputedStyle(node).overflowX;
      if (overflowX !== "auto" && overflowX !== "scroll") continue;
      var max = node.scrollWidth - node.clientWidth;
      if (max <= 0) continue;
      // Fingers moving left make deltaX positive and scroll the content right.
      if (deltaX > 0 ? node.scrollLeft < max : node.scrollLeft > 0) return true;
    }
    return false;
  }

  // The app cannot see wheel events that land inside the frame, so they are
  // handed over for its swipe gesture. A gesture that begins on content which
  // can still scroll sideways belongs to that content, from first event to last.
  var lastWheel = 0;
  var gestureOwnedByContent = false;

  document.addEventListener(
    "wheel",
    function (event) {
      if (event.ctrlKey) return; // pinch-zoom arrives as ctrl+wheel
      if (event.timeStamp - lastWheel > GESTURE_IDLE_MS) {
        gestureOwnedByContent = scrollsSideways(event.target, event.deltaX);
      }
      lastWheel = event.timeStamp;
      if (gestureOwnedByContent) return;
      send({
        type: WHEEL,
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        deltaMode: event.deltaMode,
      });
    },
    { passive: true },
  );

  var lastHeight = -1;

  function reportHeight() {
    var height = document.documentElement.scrollHeight;
    if (height > 0 && height !== lastHeight) {
      lastHeight = height;
      send({ type: HEIGHT, height: height });
    }
  }

  // Images and fonts settle after the first paint, so keep watching.
  if (typeof ResizeObserver === "function") {
    new ResizeObserver(reportHeight).observe(document.documentElement);
  }
  window.addEventListener("load", reportHeight);
  reportHeight();
})();
