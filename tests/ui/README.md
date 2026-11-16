# UI smoke tests (browser-level, mock host mode)

Run: `node --test "tests/ui/*.test.js"` (or `npm run test:ui`). Runtime is roughly 10 s.
Node 22 does not accept a bare directory (`node --test tests/ui/` fails), hence the quoted glob.

Prerequisites: Node 22+ and Playwright with Chromium. Outside the pre-provisioned CI/agent
environment run `npm i -D playwright` then `npx playwright install chromium` once.

The tests serve `WebAssets/` from a throwaway local HTTP server and load `index.html` in headless
Chromium. Because `window.__TAURI__` is absent, `app.js` falls back to its mock host, so these tests
cover the DOM/keyboard behaviour of the front end only: edit/view toggling, dirty tracking, the
About dialog, the version bar, Print View (paged.js), the save/save-as flow as console log lines,
and link routing in the preview (`window.tcbLinks.classifyLink` is exposed for this; external
links are observed by stubbing `window.open`, which is what the mock host calls).
They cannot exercise Tauri IPC commands, native file/save dialogs, pulldown-cmark rendering or
feature detection (mock mode always reports no features), or Windows WebView2 behaviour.

`tauri-host.test.js` instead injects a fake `window.__TAURI__` before `app.js` runs, so `app.js`
uses its Tauri host (`makeTauriHost`): the fake records every `invoke()` call and serves two files,
a version list and an updater. It covers save timing (typing during a save, `Ctrl+S` with no
edits), resetting the version bar when another file is opened, shortcuts on non-Latin layouts,
and the start-up update check (it waits for the 5 s check, so this file takes about 15 s).
