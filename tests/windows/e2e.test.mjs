// End-to-end checks of the real tcb.exe on Windows (WebView2).
//
// Runs in CI on windows-latest (see .github/workflows/ci.yml, job bundle-windows) against
// an e2e build of tcb.exe made with src-tauri/tauri.e2e.conf.json, which only adds
// --remote-debugging-port=9222 to the window's additionalBrowserArgs. Each test launches
// that exe with a file argument and drives the page over the Chrome DevTools Protocol
// (Node 22's built-in WebSocket).
//
// Why not WebDriver or an environment variable: wry always passes its own
// AdditionalBrowserArguments, and WebView2 then ignores WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS
// (no debug port appeared on any of 9 launches in CI). msedgedriver relies on that variable,
// so it failed with "DevToolsActivePort file doesn't exist"; it also passed the file
// argument as a mangled "--d:\...\test.md" switch.
//
// It covers the items of tests/windows-manual-checks.md that need no native dialog: real
// Tauri IPC (argv open, Rust rendering, git version info), on-disk text formats, local
// image inlining, raw-HTML handling, flavor badges, the not-text error, and the window /
// webview permissions behind the title and zoom features.
//
// Requirements: Windows, Node 22+, env TCB_EXE (path to the e2e build of tcb.exe).
// Run: node --test "tests/windows/*.test.mjs"
//
// Native dialogs (the unsaved-changes prompt, Open, Save As) are operated through Windows UI
// Automation by tests/windows/uia.ps1. Not covered: drag-and-drop from Explorer, the default
// browser / mail client actually opening, the print dialog, wheel / pinch zoom and
// auto-update (see tests/windows-manual-checks.md); the installer is checked by its own CI step.

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
const PORT = Number(process.env.TCB_DEBUG_PORT || 9222);

function killTree(pid) {
  spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
}

/** Launch tcb.exe on `file` and return a CDP-backed handle to its WebView2 page. */
async function openApp(file, { waitForLoad = true } = {}) {
  const port = PORT;
  const proc = spawn(APP, [file], { stdio: 'ignore' });
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
    get exited() { return exited; },
    /** Close the window through Tauri so WebView2 shuts down cleanly (storage flushed). */
    async quit() {
      send('Runtime.evaluate', { expression: 'window.__TAURI__.window.getCurrentWindow().destroy()' }).catch(() => {});
      for (let i = 0; i < 100 && exited === null; i++) await sleep(100);
      await app.close();
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
        // The title updates before the file's render lands, and the welcome page is already
        // rendered, so also wait until the welcome text has been replaced.
        `const t = document.getElementById('docTitle')?.textContent || '';
         const pv = document.getElementById('preview');
         return t.includes(${JSON.stringify(name)}) && pv.children.length > 0
           && !pv.textContent.includes('from File Explorer');`,
        `launch file ${name} to load`,
      );
    } catch (err) { await app.close(); throw err; }
  }
  return app;
}

const text = (app, sel) => app.eval(`return document.querySelector(${JSON.stringify(sel)})?.textContent ?? null;`);
const key = (app, k, mods = {}) => app.eval(
  `document.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(k)}, ctrlKey: true, shiftKey: ${!!mods.shift}, bubbles: true }));`);
/** Press a button in a native tcb.exe dialog via UI Automation; resolves to the script output. */
function uia(title, button, filePath) {
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(REPO, 'tests', 'windows', 'uia.ps1'),
    '-Title', title, '-Button', button];
  if (filePath) args.push('-Path', filePath);
  const r = spawnSync('powershell.exe', args, { encoding: 'utf8', timeout: 60_000 });
  return (r.stdout || '').trim() + (r.status ? ` (exit ${r.status}) ${(r.stderr || '').trim()}` : '');
}
/** Copy a fixture to a fresh file so tests that save never share a path. */
let copyN = 0;
function fresh(name) {
  const dst = path.join(fixtures, `${path.parse(name).name}-${++copyN}${path.extname(name)}`);
  fs.copyFileSync(path.join(fixtures, name), dst);
  return dst;
}
/** Append a line in the editor and save with Ctrl+S; resolves once the dirty dot clears. */
async function editAndSave(app, line) {
  await app.eval(`const e = document.getElementById('editor'); e.value += ${JSON.stringify(line)}; e.dispatchEvent(new Event('input'));`);
  await key(app, 's');
  await app.waitFor(`return document.getElementById('dirtyDot').hidden;`, 'save to finish');
}

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
  fs.writeFileSync(path.join(fixtures, 'crlf.md'), '# CRLF doc\r\n\r\nalpha\r\nbeta\r\n');
  fs.writeFileSync(path.join(fixtures, 'abs-image.md'),
    `# Abs\n\n![abs](<${path.join(fixtures, 'images', 'fig.png')}>)\n`);
  // Links: a.md -> sub/b.md#details, plus missing / ignored / in-page links.
  fs.mkdirSync(path.join(fixtures, 'sub'));
  const filler = Array.from({ length: 80 }, (_, i) => `Paragraph ${i}.`).join('\n\n');
  fs.writeFileSync(path.join(fixtures, 'sub', 'b.md'), `# B\n\n${filler}\n\n## Details\n\nHere.\n`);
  fs.writeFileSync(path.join(fixtures, 'links.md'),
    '# Links\n\n[toc](#far-heading) [b](sub/b.md#details) [missing](nope.md) [img](pic.png) [f](file:///C:/x.md)\n\n'
    + filler + '\n\n## Far heading\n\nEnd.\n');
  fs.writeFileSync(path.join(fixtures, 'sub', 'rel.md'), '# Relative\n\nopened via second instance\n');
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
  // Start from a normal document, then open the binary file through the same path a second
  // instance or a drop uses: the 'open-file' event -> open_path IPC -> error alert. The alert
  // is captured in-page, because a real alert() would block the page under test.
  const app = await openApp(path.join(REPO, 'test.md'));
  const bin = path.join(fixtures, 'binary.md');
  try {
    const direct = await app.eval(`try { await window.__TAURI__.core.invoke('open_path', { path: ${JSON.stringify(bin)} }); return 'opened'; }
      catch (e) { return String(e && e.message || e); }`);
    assert.match(direct, /not valid UTF-8/, direct);

    await app.eval(`window.__alerts = []; window.alert = (m) => window.__alerts.push(String(m));
      await window.__TAURI__.event.emit('open-file', ${JSON.stringify(bin)});`);
    const shown = await app.waitFor(`return window.__alerts.length ? window.__alerts[0] : null;`, 'error alert');
    assert.match(shown, /Could not open file[\s\S]*not valid UTF-8/, shown);
    // The previous document is still loaded.
    assert.match(await text(app, '#docTitle'), /test\.md/);
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

test('saving keeps CRLF, UTF-8 BOM and UTF-16 LE byte-for-byte except the edit', { skip }, async () => {
  for (const [name, decode, eol] of [
    ['crlf.md', (b) => b.toString('utf8'), '\r\n'],
    ['crlf-bom.md', (b) => b.toString('utf8'), '\r\n'],
    ['utf16.md', (b) => b.subarray(2).toString('utf16le'), '\r\n'],
  ]) {
    const file = fresh(name);
    const before = fs.readFileSync(file);
    const app = await openApp(file);
    try {
      await editAndSave(app, '\nadded line');
    } finally { await app.close(); }
    const after = fs.readFileSync(file);
    // Same leading bytes (BOM / UTF-16 BOM) and the original text is a prefix of the new text.
    assert.deepEqual(after.subarray(0, 3), before.subarray(0, 3), name + ' lost its BOM');
    const oldText = decode(before), newText = decode(after);
    assert.ok(newText.startsWith(oldText.replace(/\uFEFF/, '')) || newText.startsWith(oldText), name + ': ' + JSON.stringify(newText));
    assert.ok(newText.endsWith(eol + 'added line'), name + ': ' + JSON.stringify(newText.slice(-20)));
    assert.ok(!/[^\r]\n/.test(newText), name + ' has a bare LF after save: ' + JSON.stringify(newText));
  }
});

test('launching on a missing file shows the welcome page', { skip }, async () => {
  const app = await openApp(path.join(fixtures, 'does-not-exist.md'), { waitForLoad: false });
  try {
    const h1 = await app.waitFor(`return document.querySelector('#preview h1')?.textContent;`, 'welcome render');
    assert.equal(h1, 'Welcome');
    assert.equal(await text(app, '#docTitle'), 'untitled.md');
    assert.equal(app.exited, null, 'app must still be running');
  } finally { await app.close(); }
});

test('native title gains a leading bullet when the document is dirty', { skip }, async () => {
  const app = await openApp(fresh('crlf.md'));
  try {
    await app.eval(`const e = document.getElementById('editor'); e.value += 'x'; e.dispatchEvent(new Event('input'));`);
    const t = await app.waitFor(`const t = await window.__TAURI__.window.getCurrentWindow().title(); return t.startsWith('• ') ? t : null;`, 'dirty native title');
    assert.match(t, /^• crlf-\d+\.md — TCB, M\.D\.$/);
  } finally { await app.close(); }
});

test('a second instance with a relative path opens it in the running window', { skip }, async () => {
  const app = await openApp(path.join(REPO, 'test.md'));
  try {
    const second = spawn(APP, ['rel.md'], { cwd: path.join(fixtures, 'sub'), stdio: 'ignore' });
    const code = await new Promise((r) => second.on('exit', r));
    assert.equal(code, 0, 'second instance should hand off and exit');
    await app.waitFor(`return document.getElementById('docTitle').textContent.includes('rel.md')
      && document.querySelector('#preview h1')?.textContent === 'Relative';`, 'forwarded file to open and render');
  } finally { await app.close(); }
});

test('zoom set with Ctrl+= survives a relaunch', { skip }, async () => {
  let app = await openApp(path.join(REPO, 'test.md'));
  try {
    await key(app, '0');
    await app.waitFor(`return localStorage.getItem('mdview.zoom') === '1';`, 'zoom reset to 100%');
    await sleep(300);
    const at100 = await app.eval(`return { dpr: window.devicePixelRatio, w: window.innerWidth };`);
    await key(app, '=');
    await key(app, '=');
    assert.equal(await app.waitFor(`return localStorage.getItem('mdview.zoom') === '1.25' ? '1.25' : null;`, 'zoom stored'), '1.25');
    // The WebView2 zoom itself changed: page zoom shrinks the CSS viewport (and may scale
    // devicePixelRatio). Accept either signal; the failure message reports both.
    await app.waitFor(`const w = window.innerWidth, d = window.devicePixelRatio;
      const ok = Math.abs(${at100.w} / w - 1.25) < 0.03 || Math.abs(d / ${at100.dpr} - 1.25) < 0.03;
      if (ok) return true; window.__zoomDiag = { at100: ${JSON.stringify(at100)}, now: { dpr: d, w } }; return false;`, 'webview zoom applied')
      .catch(async (err) => { throw new Error(err.message + ' ' + JSON.stringify(await app.eval('return window.__zoomDiag;'))); });
  } finally { await app.quit(); }
  app = await openApp(path.join(REPO, 'test.md'));
  try {
    assert.equal(await app.eval(`return localStorage.getItem('mdview.zoom');`), '1.25');
    await key(app, '0');
    assert.equal(await app.waitFor(`return localStorage.getItem('mdview.zoom') === '1' ? '1' : null;`, 'zoom reset'), '1');
  } finally { await app.quit(); }
});

test('preview links: in-page, relative .md with fragment, missing, ignored', { skip }, async () => {
  const app = await openApp(path.join(fixtures, 'links.md'));
  const click = (label) => app.eval(`[...document.querySelectorAll('#preview a')].find(a => a.textContent === ${JSON.stringify(label)}).click();`);
  try {
    await app.eval(`window.__alerts = []; window.alert = (m) => window.__alerts.push(String(m));`);
    // In-page fragment scrolls the preview.
    await click('toc');
    assert.ok(await app.waitFor(`const h = document.getElementById('far-heading'); const r = h.getBoundingClientRect(); return r.top < window.innerHeight && r.top >= 0;`, 'scroll to far heading'));
    // Ignored links do nothing.
    await click('img');
    await click('f');
    await sleep(500);
    assert.match(await text(app, '#docTitle'), /links\.md/);
    assert.equal(await app.eval(`return window.__alerts.length;`), 0);
    // Missing .md target: error alert, document stays.
    await click('missing');
    const msg = await app.waitFor(`return window.__alerts[0] || null;`, 'missing-file alert');
    assert.match(msg, /Could not open file/);
    assert.match(await text(app, '#docTitle'), /links\.md/);
    // Relative .md with fragment opens and scrolls to the heading.
    await click('b');
    await app.waitFor(`return document.getElementById('docTitle').textContent.includes('b.md');`, 'b.md to open');
    assert.ok(await app.waitFor(`const h = document.getElementById('details'); if (!h) return false; const r = h.getBoundingClientRect(); return r.top < window.innerHeight && r.top >= 0;`, 'scroll to Details'));
  } finally { await app.close(); }
});

test('external links go through the opener permission', { skip }, async () => {
  const app = await openApp(path.join(REPO, 'test.md'));
  try {
    const r = await app.eval(`try { await window.__TAURI__.opener.openUrl('https://example.com/'); return 'ok'; } catch (e) { return 'ERR ' + e; }`);
    assert.equal(r, 'ok');
  } finally { await app.close(); }
});

test('history: backup-before-restore snapshot is listed for a git file; rapid saves keep every snapshot', { skip }, async () => {
  // A throwaway git repo with two commits of doc.md in a subfolder.
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'tcb-git-'));
  const git = (...a) => { const r = spawnSync('git', a, { cwd: repo, encoding: 'utf8' }); if (r.status) throw new Error(r.stderr); };
  git('init', '-q'); git('config', 'user.email', 'e2e@example.invalid'); git('config', 'user.name', 'e2e');
  fs.mkdirSync(path.join(repo, 'docs'));
  const doc = path.join(repo, 'docs', 'doc.md');
  fs.writeFileSync(doc, '# v1\n'); git('add', '.'); git('commit', '-qm', 'one');
  fs.writeFileSync(doc, '# v2\n'); git('commit', '-qam', 'two');

  let app = await openApp(doc);
  try {
    assert.match(await app.waitFor(`const t = document.getElementById('versionInfo').textContent; return /2 commits/.test(t) ? t : null;`, 'two commits'), /git: .* · clean · 2 commits/);
    await key(app, 'h');
    await app.waitFor(`return document.querySelectorAll('#versionPicker option').length >= 3;`, 'versions listed');
    // Select the older commit ("one"), keep "Backup current first" ticked, restore.
    await app.eval(`const p = document.getElementById('versionPicker');
      p.value = [...p.options].find(o => o.textContent.includes('one')).value; p.dispatchEvent(new Event('change'));`);
    await app.waitFor(`return !document.getElementById('restoreSelectedBtn').disabled;`, 'diff loaded');
    assert.equal(await app.eval(`return document.getElementById('backupFirst').checked;`), true);
    await app.eval(`document.getElementById('restoreSelectedBtn').click();`);
    await app.waitFor(`return document.getElementById('editor').value.startsWith('# v1');`, 'restore');
    await app.waitFor(`return /1 snapshot/.test(document.getElementById('versionInfo').textContent);`, 'snapshot count in status bar');
    const versions = await app.eval(`return await window.__TAURI__.core.invoke('list_versions', { path: ${JSON.stringify(doc)} });`);
    assert.equal(versions.filter((v) => v.label === 'snapshot').length, 1, JSON.stringify(versions));
    assert.equal(versions.filter((v) => v.author).length, 2, JSON.stringify(versions));
  } finally { await app.close(); fs.rmSync(repo, { recursive: true, force: true }); }

  // Outside git: three saves inside a second or two give three distinct snapshots.
  const plain = fresh('crlf.md');
  app = await openApp(plain);
  try {
    for (const n of [1, 2, 3]) await editAndSave(app, `\nsave ${n}`);
    const v = await app.eval(`return await window.__TAURI__.core.invoke('list_versions', { path: ${JSON.stringify(plain)} });`);
    assert.equal(v.length, 3, JSON.stringify(v));
    assert.equal(new Set(v.map((x) => x.id)).size, 3);
  } finally { await app.close(); }
});

test('absolute local image paths are inlined too', { skip }, async () => {
  const app = await openApp(path.join(fixtures, 'abs-image.md'));
  try {
    assert.ok(await app.waitFor(`const i = document.querySelector('#preview img[alt=abs]'); return i && i.getAttribute('src').startsWith('data:image/png;base64,') && i.naturalWidth === 1;`, 'absolute image inlined and decoded'));
  } finally { await app.close(); }
});

// The window title as Windows shows it (app.js sets "<name> — TCB, M.D.", with "• " when dirty).
const winTitle = (file, dirty) => `${dirty ? '• ' : ''}${path.basename(file)} — TCB, M.D.`;

test('closing with unsaved edits asks first: No keeps the window, Yes closes it', { skip }, async () => {
  const file = fresh('crlf.md');
  const app = await openApp(file);
  try {
    await app.eval(`const e = document.getElementById('editor'); e.value += 'unsaved'; e.dispatchEvent(new Event('input'));`);
    // Close the way the X button does: WM_CLOSE through UI Automation.
    assert.equal(uia(winTitle(file, true), '__close__'), 'OK');
    assert.equal(uia('Unsaved changes', 'No'), 'OK');
    await sleep(1000);
    assert.equal(app.exited, null, 'window must stay open after No');
    assert.equal(await app.eval(`return !document.getElementById('dirtyDot').hidden;`), true, 'edits must survive');
    assert.equal(uia(winTitle(file, true), '__close__'), 'OK');
    assert.equal(uia('Unsaved changes', 'Yes'), 'OK');
    for (let i = 0; i < 100 && app.exited === null; i++) await sleep(100);
    assert.notEqual(app.exited, null, 'window must close after Yes');
  } finally { await app.close(); }
});

test('closing without edits does not ask', { skip }, async () => {
  const file = fresh('crlf.md');
  const app = await openApp(file);
  try {
    assert.equal(uia(winTitle(file, false), '__close__'), 'OK');
    for (let i = 0; i < 100 && app.exited === null; i++) await sleep(100);
    assert.notEqual(app.exited, null, 'clean window should close immediately');
  } finally { await app.close(); }
});

test('Ctrl+O opens a file through the native Open dialog', { skip }, async () => {
  const target = fresh('crlf-bom.md');
  const app = await openApp(path.join(REPO, 'test.md'));
  try {
    await key(app, 'o');
    assert.equal(uia('Open', 'Open', target), 'OK');
    await app.waitFor(`return document.getElementById('docTitle').textContent.includes(${JSON.stringify(path.basename(target))});`, 'picked file to open');
    assert.equal(await text(app, '#fileFormat'), 'CRLF · UTF-8 BOM');
  } finally { await app.close(); }
});

test('Ctrl+Shift+S saves to a new path through the native Save As dialog', { skip }, async () => {
  const src = fresh('crlf.md');
  const dst = path.join(fixtures, `saved-as-${Date.now()}.md`);
  const app = await openApp(src);
  try {
    await app.eval(`const e = document.getElementById('editor'); e.value += '\\nsaved as'; e.dispatchEvent(new Event('input'));`);
    await key(app, 's', { shift: true });
    assert.equal(uia('Save As', 'Save', dst), 'OK');
    await app.waitFor(`return document.getElementById('docTitle').textContent.includes(${JSON.stringify(path.basename(dst))});`, 'title to switch to the new path');
    await app.waitFor(`return document.getElementById('dirtyDot').hidden;`, 'clean after save');
    const bytes = fs.readFileSync(dst, 'utf8');
    assert.ok(bytes.endsWith('\r\nsaved as'), JSON.stringify(bytes.slice(-20)));
    assert.ok(!/[^\r]\n/.test(bytes), 'CRLF kept in the new file');
  } finally { await app.close(); }
});
