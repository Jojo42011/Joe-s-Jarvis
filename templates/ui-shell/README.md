# Neutral UI Shell — the "hull"

A brand-free, color-free layout template: a **collapsible sidebar** + **tabbed iframe
views**, where each tab is any page/app you embed, and a voice assistant (or any
backend) can **switch tabs programmatically** while staying live in the background.

Drop `shell.html` in as your app's landing page, point the tabs at your own pages,
theme it with a few CSS variables, and wire the one-line navigation contract.

---

## 1. What you get

- **Sidebar → tabs.** Each sidebar item shows one iframe view. Config is one JS array.
- **Collapsible sidebar.** Toggle button or `Ctrl/⌘ + \`. When collapsed, the current
  tab **maximizes full-screen**; a floating "Menu" pill reopens it. State persists.
- **Persistent home tab.** The first tab (`home:true`) loads immediately and stays
  loaded in the background — so if it's a voice assistant, it keeps talking/listening
  even while another tab is on screen ("speaks over" the tab).
- **Programmatic / voice navigation.** Any embedded page can tell the shell to switch
  tabs with one `postMessage` — see §3.
- **Lazy loading, deep links (`?tab=key`), a tiny `window.AppShell` API.**

No framework, no build step, no dependencies. One HTML file.

---

## 2. Configure

Edit the `TABS` array near the bottom of `shell.html`:

```js
var TABS = [
  { key:"home",  label:"Assistant", sub:"Home",    src:"/assistant", home:true },
  { key:"stats", label:"Stats",     sub:"Metrics", src:"/stats" },
  { key:"docs",  label:"Docs",      sub:"Files",   src:"/docs" },
];
```

- `key` — unique id used by navigation (`postMessage({tab:"stats"})`).
- `src` — the page to embed. **Use same-origin URLs** so `postMessage` works and audio
  persists across tab switches.
- `home:true` — the primary tab (loads now, stays live). Usually your assistant.
- `icon` — optional inline `<svg>` string.

**Theme:** override the CSS variables in `:root` (`--bg`, `--accent`, `--line`, …).
Change `--accent` and it re-skins. Defaults are neutral grayscale.

---

## 3. The navigation contract (the important part)

**The rule:** an embedded page switches the shell's tab by posting a message to the
parent window:

```js
window.parent.postMessage({ type: "app-navigate", tab: "stats" }, "*");
```

That's the entire contract. The shell listens for `type: "app-navigate"` and opens
that tab. (Rename the type via `NAV_MESSAGE_TYPE` in `shell.html`.)

### Voice → tab, end to end

If your assistant page streams responses from a backend, have the backend emit a
"navigate" signal and forward it to the parent. Three neutral pieces:

**(a) Backend decides to open a tab.** However your model/agent works, produce a
directive. If you use LLM tool/function-calling, define a tool like:

```json
{
  "name": "open_tab",
  "description": "Open a tab in the app UI for the user.",
  "parameters": {
    "type": "object",
    "properties": { "tab": { "type": "string", "enum": ["home","stats","docs"] } },
    "required": ["tab"]
  }
}
```

When the model calls it, don't do anything server-side except **tell the client**.

**(b) Backend → client.** Send the directive down your existing channel. Example with
Server-Sent Events (SSE):

```js
// server, inside your streaming handler:
res.write(`data: ${JSON.stringify({ type: "navigate", tab })}\n\n`);
```

**(c) Client (the assistant page) → shell.** In the page you embed as the `home` tab,
forward it to the parent:

```js
// wherever you read your stream events:
if (evt.type === "navigate" && evt.tab) {
  window.parent.postMessage({ type: "app-navigate", tab: evt.tab }, "*");
}
```

Done. Say *"show me the stats"* → model calls `open_tab({tab:"stats"})` → SSE
`{type:"navigate",tab:"stats"}` → the page posts `app-navigate` → the shell opens the
Stats tab while the assistant keeps talking over it.

`voice-nav-bridge.js` in this folder is a ready-to-include version of step (c).

### No backend? Drive it directly.

From the shell window itself: `window.AppShell.open("stats")`.
From any same-origin embedded page: the `postMessage` line above.

---

## 4. Notes / gotchas

- **Same-origin iframes** are strongly recommended: cross-origin breaks `postMessage`
  targeting and can block autoplay/mic. If a tab must be cross-origin, it still renders,
  but it can't request navigation and its audio won't persist reliably.
- **Persistent audio:** the home tab is never unloaded, just hidden — that's why a
  voice assistant keeps running while you view another tab.
- **`allow="microphone; autoplay; camera"`** is set on every iframe; trim it if a view
  doesn't need those permissions.
- **Security:** the shell accepts `app-navigate` from any origin (`"*"`). If you embed
  untrusted pages, check `e.origin` in the message listener before acting.

---

## 5. Files

| File | Purpose |
|---|---|
| `shell.html` | The whole shell — sidebar, tabs, collapse, navigation. Drop-in. |
| `voice-nav-bridge.js` | Paste/include in your assistant page to forward stream `navigate` events to the shell. |
| `README.md` | This file. |
