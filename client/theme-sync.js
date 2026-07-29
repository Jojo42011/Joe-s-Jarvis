/* theme-sync.js — one line of theming for every screen.
   The shell owns the light/dark choice and broadcasts it into each iframe by
   postMessage; a screen opened directly (or before the shell's first message)
   reads localStorage so it never flashes the wrong theme. */
(function () {
  "use strict";
  var KEY = "to_theme";

  function apply(theme) {
    var t = theme === "dark" ? "dark" : "light";
    document.documentElement.setAttribute("data-theme", t);
    try { localStorage.setItem(KEY, t); } catch (_) {}
  }

  // Run before paint so there's no flash of the wrong theme.
  try { apply(localStorage.getItem(KEY) || "light"); } catch (_) { apply("light"); }

  window.addEventListener("message", function (e) {
    var d = e.data || {};
    if (d.type === "theme" && d.theme) apply(d.theme);
  });

  window.__setTheme = apply;
})();
