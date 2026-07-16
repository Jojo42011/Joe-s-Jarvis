/*
 * voice-nav-bridge.js — include this in the page you embed as the shell's "home"
 * tab (e.g. your voice assistant). It forwards a backend "navigate" directive up
 * to the parent shell, which switches tabs. Neutral — no framework, no brand.
 *
 * Two ways to use it:
 *
 * 1) If you read a stream (SSE / fetch reader / WebSocket) of events, call
 *    ShellNav.handle(evt) on each event. It fires when evt looks like
 *    { type: "navigate", tab: "<key>" }.
 *
 * 2) Call ShellNav.go("stats") directly whenever you decide to switch tabs.
 *
 * The shell listens for: window.postMessage({ type: "app-navigate", tab }).
 * Keep NAV_MESSAGE_TYPE in sync with the shell's NAV_MESSAGE_TYPE.
 */
(function (global) {
  var NAV_MESSAGE_TYPE = "app-navigate";

  function go(tab) {
    if (!tab) return;
    try {
      // Post to the parent window (the shell). "*" targetOrigin is fine for
      // same-origin embeds; tighten to your origin if you want.
      (window.parent || window).postMessage({ type: NAV_MESSAGE_TYPE, tab: String(tab).toLowerCase() }, "*");
    } catch (e) { /* not embedded / blocked — ignore */ }
  }

  function handle(evt) {
    if (evt && evt.type === "navigate" && evt.tab) go(evt.tab);
  }

  global.ShellNav = { go: go, handle: handle };
})(window);

/* ---- Example wiring (delete — for reference) ----

// SSE:
const es = new EventSource("/assistant/stream");
es.onmessage = (m) => { const d = JSON.parse(m.data); ShellNav.handle(d); /* ...your other handling... *\/ };

// fetch() streaming reader:
for (const line of lines) {
  const d = JSON.parse(line.replace(/^data: /, ""));
  ShellNav.handle(d);
}

// direct:
ShellNav.go("stats");

--------------------------------------------------- */
