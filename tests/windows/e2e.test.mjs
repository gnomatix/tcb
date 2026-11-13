// End-to-end checks of the real tcb.exe on Windows (WebView2).
//
// Runs in CI on windows-latest after the release build (see .github/workflows/ci.yml,
// job bundle-windows). Each test launches tcb.exe with a file argument and with
// WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=<n>, then drives the page
// over the Chrome DevTools Protocol (Node 22's built-in WebSocket). No WebDriver: in CI,
// msedgedriver both mangled the file argument (passing "--d:\...\test.md") and failed to
// discover the WebView2 debugging port ("DevToolsActivePort file doesn't exist").
//
// It covers the items of tests/windows-manual-checks.md that need no native dialog: real
// Tauri IPC (argv open, Rust rendering, git version info), on-disk text formats, local
// image inlining, raw-HTML handling, flavor badges, the not-text error, and the window /
// webview permissions behind the title and zoom features.
//
// Requirements: Windows, Node 22+, env TCB_EXE (path to the built tcb.exe).
// Run: node --test "tests/windows/*.test.mjs"
//
// Not covered (they need a person or a native dialog): Save As / Open dialogs, the
// close-with-unsaved-edits prompt, drag-and-drop from Explorer, opening a link in the
// default browser, file associations, the installer, and auto-update.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const APP = process.env.TCB_EXE;
const skip = process.platform !== 'win32' || !APP ? 'needs Windows and TCB_EXE' : false;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let fixtures;
let nextPort = 9300;

function killTree(pid) {
  spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
}

/** Launch tcb.exe on `file` and return a CDP-backed handle to its WebView2 page. */
async function openApp(file, { waitForLoad = true } = {}) {
  const port = nextPort++;
  const proc = spawn(APP, [file], {
    env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` },
    stdio: 'ignore',
  });
  let exited = null;
  proc.on('exit', (code) => { exited = code; });

  // Wait for the WebView2 page target.
  let target = null;
  const end = Date.now() + 30_000;
  while (!target) {
    if (exited !== null) throw new Error(`tcb.exe exited early (code ${exited})`);
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    } catch { /* not listening yet */ }
    if (!target) {
      if (Date.now() > end) { killTree(proc.pid); throw new Error(`no WebView2 debug target on port ${port} within 30s`); }
      await sleep(250);
    }
  }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('CDP websocket failed')); });
  let id = 0;
  const pending = new Map();
  const listeners = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    } else if (msg.method) {
      for (const l of listeners) l(msg);
    }
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const mid = ++id;
    pending.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });

  const app = {
    proc,
    send,
    on: (fn) => listeners.push(fn),
    /** Evaluate `body` (statements, may `await`/`return`) in the page; returns the value. */
    async eval(body) {
      const r = await send('Runtime.evaluate', {
        expression: `(async () => { ${body} })()`,
        awaitPromise: true,
        returnByValue: true,
      });
      if (r.exceptionDetails) throw new Error('page threw: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
      return r.result.value;
    },
    async waitFor(body, label, ms = 20_000) {
      const stop = Date.now() + ms;
      let last;
      for (;;) {
        try { last = await app.eval(body); if (last) return last; } catch (err) { last = err.message; }
        if (Date.now() > stop) throw new Error(`timed out waiting for ${label}; last=${JSON.stringify(last)}`);
        await sleep(250);
      }
    },
    async close() {
      try { ws.close(); } catch {}
      killTree(proc.pid);
      for (let i = 0; i < 40 && exited === null; i++) await sleep(100);
      await sleep(500);   // let WebView2 helper processes release the profile
    },
  };

  if (waitForLoad) {
    const name = path.basename(file);
    try {
      await app.waitFor(
        `const t = document.getElementById('docTitle')?.textContent || '';
         return t.includes(${JSON.stringify(name)}) && document.getElementById('preview').children.length > 0;`,
        `launch file ${name} to load`,
      );
    } catch (err) { await app.close(); throw err; }
  }
  return app;
}

const text = (app, sel) => app.eval(`return document.querySelector(${JSON.stringify(sel)})?.textContent ?? null;`);

before(() => {
  if (skip) return;
  fixtures = fs.mkdtempSync(path.join(os.tmpdir(), 'tcb-e2e-'));
  const crlf = '# CRLF BOM doc\r\n\r\nline one\r\nline two\r\n';
  fs.writeFileSync(path.join(fixtures, 'crlf-bom.md'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(crlf)]));
  const u16 = Buffer.from('# UTF-16 doc\r\n\r\nhello\r\n', 'utf16le');
  fs.writeFileSync(path.join(fixtures, 'utf16.md'), Buffer.concat([Buffer.from([0xff, 0xfe]), u16]));
  fs.mkdirSync(path.join(fixtures, 'images'));
  // 1x1 transparent PNG.
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
  fs.writeFileSync(path.join(fixtures, 'images', 'fig.png'), png);
  fs.writeFileSync(path.join(fixtures, 'images.md'),
    '# Images\n\n![local](images/fig.png)\n\n![escape](../../outside.png)\n\n![web](https://example.com/x.png)\n');
  fs.writeFileSync(path.join(fixtures, 'binary.md'), Buffer.from([0x00, 0xff, 0xfe, 0x80, 0x81, 0x00]));
});

after(() => {
  if (fixtures) fs.rmSync(fixtures, { recursive: true, force: true });
});

test('test.md opens from argv, renders via Rust, and keeps raw HTML literal', { skip }, async () => {
  const app = await openApp(path.join(REPO, 'test.md'));
  try {
    assert.equal(await text(app, '#fileFormat'), 'LF · UTF-8');
    const raw = await app.eval(`
      const p = document.getElementById('preview');
      return { literal: p.textContent.includes('<b>not bold</b>'),
               bold: [...p.querySelectorAll('b')].some(b => b.textContent === 'not bold'),
               scripts: p.querySelectorAll('script,style').length,
               doubleEscaped: p.textContent.includes('&lt;b&gt;') };`);
    assert.deepEqual(raw, { literal: true, bold: false, scripts: 0, doubleEscaped: false });
    assert.ok(await app.waitFor(`return document.querySelector('#preview hr.mdview-pagebreak') !== null;`, 'pagebreak hr'));
    assert.ok(await app.waitFor(`return document.querySelector('#preview .katex') !== null;`, 'KaTeX render'));
  } finally { await app.close(); }
});

test('feature badges come from the Rust detector and GFM flags the right ones', { skip }, async () => {
  const app = await openApp(path.join(REPO, 'test.md'));
  try {
    await app.eval(`const f = document.getElementById('flavorSelect'); f.value = 'gfm'; f.dispatchEvent(new Event('change'));`);
    const badges = await app.eval(`return [...document.querySelectorAll('#features .feature-badge')]
      .map(b => ({ label: b.textContent, bad: b.classList.contains('feature-badge--incompatible') }));`);
    const by = Object.fromEntries(badges.map((b) => [b.label, b.bad]));
    for (const l of ['frontmatter', 'math', 'wikilinks', 'heading-attrs', 'definitions']) {
      assert.equal(by[l], true, `${l} should be flagged under GFM; got ${JSON.stringify(badges)}`);
    }
    for (const l of ['tables', 'tasklists', 'strikethrough', 'footnotes', 'github-alerts', 'pagebreaks']) {
      assert.equal(by[l], false, `${l} should be allowed under GFM; got ${JSON.stringify(badges)}`);
    }
  } finally { await app.close(); }
});

test('a file in a repository subfolder shows git history (toplevel fix)', { skip }, async () => {
  const app = await openApp(path.join(REPO, 'tests', 'windows-manual-checks.md'));
  try {
    const info = await app.waitFor(
      `const t = document.getElementById('versionInfo').textContent; return t.startsWith('git:') ? t : null;`,
      'git version info');
    const m = /(\d+) commits?/.exec(info);
    assert.ok(m && Number(m[1]) > 0, `expected a commit count > 0, got ${JSON.stringify(info)}`);
  } finally { await app.close(); }
});

test('UTF-8 BOM + CRLF is detected and the BOM does not leak into the text', { skip }, async () => {
  const app = await openApp(path.join(fixtures, 'crlf-bom.md'));
  try {
    assert.equal(await text(app, '#fileFormat'), 'CRLF · UTF-8 BOM');
    assert.equal(await text(app, '#preview h1'), 'CRLF BOM doc');
    const editor = await app.eval(`return document.getElementById('editor').value;`);
    assert.ok(!editor.includes('\r') && !editor.startsWith('\uFEFF'), JSON.stringify(editor));
  } finally { await app.close(); }
});

test('UTF-16 LE opens and is reported as such', { skip }, async () => {
  const app = await openApp(path.join(fixtures, 'utf16.md'));
  try {
    assert.equal(await text(app, '#fileFormat'), 'CRLF · UTF-16 LE');
    assert.equal(await text(app, '#preview h1'), 'UTF-16 doc');
  } finally { await app.close(); }
});

test('local images are inlined; escaping and web images are left alone', { skip }, async () => {
  const app = await openApp(path.join(fixtures, 'images.md'));
  try {
    const imgs = await app.eval(`return [...document.querySelectorAll('#preview img')]
      .map(i => ({ alt: i.alt, src: i.getAttribute('src').slice(0, 30) }));`);
    const by = Object.fromEntries(imgs.map((i) => [i.alt, i]));
    assert.ok(by.local?.src.startsWith('data:image/png;base64,'), JSON.stringify(imgs));
    assert.equal(by.escape?.src, '../../outside.png');
    assert.ok(by.web?.src.startsWith('https://example.com/'), JSON.stringify(imgs));
    // The inlined image actually decodes in WebView2.
    assert.ok(await app.waitFor(`return document.querySelector('#preview img[alt=local]').naturalWidth === 1;`, 'image decode'));
  } finally { await app.close(); }
});

test('a non-text file reports why it could not be opened', { skip }, async () => {
  const app = await openApp(path.join(fixtures, 'binary.md'), { waitForLoad: false });
  try {
    // The alert is raised after the window is shown; it may already be open when we attach,
    // so record alerts from the start and also check for one that is already showing.
    let message = null;
    app.on((m) => { if (m.method === 'Page.javascriptDialogOpening') message = m.params.message; });
    await app.send('Page.enable');
    const end = Date.now() + 20_000;
    while (!message && Date.now() < end) await sleep(250);
    assert.ok(message && /not valid UTF-8/.test(message), `alert text: ${JSON.stringify(message)}`);
    await app.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
  } finally { await app.close(); }
});

test('window title and webview zoom permissions work through Tauri IPC', { skip }, async () => {
  const app = await openApp(path.join(REPO, 'test.md'));
  try {
    const title = await app.eval(`try { return await window.__TAURI__.window.getCurrentWindow().title(); } catch (e) { return 'ERR ' + e; }`);
    assert.equal(title, 'test.md — TCB, M.D.');
    const zoom = await app.eval(`try { await window.__TAURI__.webview.getCurrentWebview().setZoom(1.1); return 'ok'; } catch (e) { return 'ERR ' + e; }`);
    assert.equal(zoom, 'ok');
    // Keyboard path: Ctrl+0 resets the zoom and persists it.
    await app.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: '0', ctrlKey: true, bubbles: true }));`);
    assert.equal(await app.waitFor(`return localStorage.getItem('mdview.zoom');`, 'zoom persisted'), '1');
  } finally { await app.close(); }
});

test('Ctrl+E toggles edit mode and edits mark the document dirty', { skip }, async () => {
  const app = await openApp(path.join(REPO, 'test.md'));
  try {
    await app.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'e', ctrlKey: true, bubbles: true }));`);
    assert.ok(await app.waitFor(`return document.body.classList.contains('mode-edit');`, 'edit mode'));
    await app.eval(`const e = document.getElementById('editor'); e.value += '\\nmore'; e.dispatchEvent(new Event('input'));`);
    const st = await app.eval(`return { dot: !document.getElementById('dirtyDot').hidden, title: document.title };`);
    assert.equal(st.dot, true);
    assert.ok(st.title.startsWith('• '), st.title);
  } finally { await app.close(); }
});
