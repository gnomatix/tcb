// End-to-end checks of the real tcb.exe on Windows (WebView2), driven over WebDriver.
//
// Runs in CI on windows-latest after the release build (see .github/workflows/ci.yml,
// job bundle-windows). It covers the items of tests/windows-manual-checks.md that need
// no native dialog: real Tauri IPC (open, render, version info), on-disk text formats,
// local image inlining, raw-HTML handling, flavor badges, and the window/webview
// permissions behind the title and zoom features.
//
// Requirements (CI installs them): tauri-driver on PATH, msedgedriver.exe matching the
// WebView2 runtime, and env TCB_EXE (path to the built tcb.exe), MSEDGEDRIVER (path to
// msedgedriver.exe). Run: node --test tests/windows/
//
// Not covered here (they need a person or a native dialog): Save As / Open dialogs, the
// close-with-unsaved-edits prompt, drag-and-drop from Explorer, opening a link in the
// default browser, file associations, the installer, and auto-update.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const APP = process.env.TCB_EXE;
const NATIVE = process.env.MSEDGEDRIVER;
const WD = 'http://127.0.0.1:4444';
const skip = process.platform !== 'win32' || !APP || !NATIVE
  ? 'needs Windows, TCB_EXE and MSEDGEDRIVER' : false;

let driver;
let fixtures;

async function wd(method, url, body) {
  const res = await fetch(WD + url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json?.value?.error) {
    throw new Error(`${method} ${url} -> ${res.status} ${JSON.stringify(json?.value ?? json).slice(0, 400)}`);
  }
  return json.value;
}

async function waitForDriver(ms = 30_000) {
  const end = Date.now() + ms;
  for (;;) {
    try { await wd('GET', '/status'); return; } catch (err) {
      if (Date.now() > end) throw new Error('tauri-driver did not start: ' + err.message);
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

/** Launch tcb.exe with `file` as its argv[1] and return a session helper. */
async function openApp(file) {
  const { sessionId } = await wd('POST', '/session', {
    capabilities: { alwaysMatch: { 'tauri:options': { application: APP, args: [file] } } },
  });
  const s = {
    id: sessionId,
    exec: (script, args = []) => wd('POST', `/session/${sessionId}/execute/sync`, { script, args }),
    execAsync: (script, args = []) => wd('POST', `/session/${sessionId}/execute/async`, { script, args }),
    close: () => wd('DELETE', `/session/${sessionId}`).catch(() => {}),
    async waitFor(script, label, ms = 20_000) {
      const end = Date.now() + ms;
      let last;
      for (;;) {
        try { last = await s.exec(script); if (last) return last; } catch (err) { last = err.message; }
        if (Date.now() > end) throw new Error(`timed out waiting for ${label}; last=${JSON.stringify(last)}`);
        await new Promise((r) => setTimeout(r, 250));
      }
    },
  };
  // The launch file has been applied once the title shows its name and the preview rendered.
  const name = path.basename(file);
  await s.waitFor(
    `const t=document.getElementById('docTitle').textContent;
     return t.includes(${JSON.stringify(name)}) && document.getElementById('preview').children.length > 0;`,
    `launch file ${name} to load`,
  );
  return s;
}

const text = (s, sel) => s.exec(`return document.querySelector(${JSON.stringify(sel)})?.textContent ?? null;`);

before(async () => {
  if (skip) return;
  driver = spawn('tauri-driver', ['--native-driver', NATIVE], { stdio: 'inherit' });
  await waitForDriver();

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
  if (driver) driver.kill();
  if (fixtures) fs.rmSync(fixtures, { recursive: true, force: true });
});

test('test.md opens from argv, renders via Rust, and keeps raw HTML literal', { skip }, async () => {
  const s = await openApp(path.join(REPO, 'test.md'));
  try {
    assert.equal(await text(s, '#fileFormat'), 'LF · UTF-8');
    const raw = await s.exec(`
      const p = document.getElementById('preview');
      return { literal: p.textContent.includes('<b>not bold</b>'),
               bold: [...p.querySelectorAll('b')].some(b => b.textContent === 'not bold'),
               scripts: p.querySelectorAll('script,style').length,
               doubleEscaped: p.textContent.includes('&lt;b&gt;') };`);
    assert.deepEqual(raw, { literal: true, bold: false, scripts: 0, doubleEscaped: false });
    // Pagebreak marker became an <hr>, math went through KaTeX.
    assert.ok(await s.waitFor(`return document.querySelector('#preview hr.mdview-pagebreak') !== null;`, 'pagebreak hr'));
    assert.ok(await s.waitFor(`return document.querySelector('#preview .katex') !== null;`, 'KaTeX render'));
  } finally { await s.close(); }
});

test('feature badges come from the Rust detector and GFM flags the right ones', { skip }, async () => {
  const s = await openApp(path.join(REPO, 'test.md'));
  try {
    await s.exec(`const f=document.getElementById('flavorSelect'); f.value='gfm'; f.dispatchEvent(new Event('change'));`);
    const badges = await s.exec(`return [...document.querySelectorAll('#features .feature-badge')]
      .map(b => ({ label: b.textContent, bad: b.classList.contains('feature-badge--incompatible') }));`);
    const by = Object.fromEntries(badges.map((b) => [b.label, b.bad]));
    for (const l of ['frontmatter', 'math', 'wikilinks', 'heading-attrs', 'definitions']) {
      assert.equal(by[l], true, `${l} should be flagged under GFM; got ${JSON.stringify(badges)}`);
    }
    for (const l of ['tables', 'tasklists', 'strikethrough', 'footnotes', 'github-alerts', 'pagebreaks']) {
      assert.equal(by[l], false, `${l} should be allowed under GFM; got ${JSON.stringify(badges)}`);
    }
  } finally { await s.close(); }
});

test('a file in a repository subfolder shows git history (toplevel fix)', { skip }, async () => {
  const s = await openApp(path.join(REPO, 'tests', 'windows-manual-checks.md'));
  try {
    const info = await s.waitFor(
      `const t=document.getElementById('versionInfo').textContent; return t.startsWith('git:') ? t : null;`,
      'git version info');
    const m = /(\d+) commits?/.exec(info);
    assert.ok(m && Number(m[1]) > 0, `expected a commit count > 0, got ${JSON.stringify(info)}`);
  } finally { await s.close(); }
});

test('UTF-8 BOM + CRLF is detected and the BOM does not leak into the text', { skip }, async () => {
  const s = await openApp(path.join(fixtures, 'crlf-bom.md'));
  try {
    assert.equal(await text(s, '#fileFormat'), 'CRLF · UTF-8 BOM');
    assert.equal(await text(s, '#preview h1'), 'CRLF BOM doc');
    const editor = await s.exec(`return document.getElementById('editor').value;`);
    assert.ok(!editor.includes('\r') && !editor.startsWith('﻿'), JSON.stringify(editor));
  } finally { await s.close(); }
});

test('UTF-16 LE opens and is reported as such', { skip }, async () => {
  const s = await openApp(path.join(fixtures, 'utf16.md'));
  try {
    assert.equal(await text(s, '#fileFormat'), 'CRLF · UTF-16 LE');
    assert.equal(await text(s, '#preview h1'), 'UTF-16 doc');
  } finally { await s.close(); }
});

test('local images are inlined; escaping and web images are left alone', { skip }, async () => {
  const s = await openApp(path.join(fixtures, 'images.md'));
  try {
    const imgs = await s.exec(`return [...document.querySelectorAll('#preview img')]
      .map(i => ({ alt: i.alt, src: i.getAttribute('src').slice(0, 30), w: i.naturalWidth }));`);
    const by = Object.fromEntries(imgs.map((i) => [i.alt, i]));
    assert.ok(by.local.src.startsWith('data:image/png;base64,'), JSON.stringify(imgs));
    assert.equal(by.escape.src, '../../outside.png');
    assert.ok(by.web.src.startsWith('https://example.com/'), JSON.stringify(imgs));
    // The inlined image actually decodes in WebView2.
    assert.ok(await s.waitFor(`return document.querySelector('#preview img[alt=local]').naturalWidth === 1;`, 'image decode'));
  } finally { await s.close(); }
});

test('a non-text file reports why it could not be opened', { skip }, async () => {
  // The app shows an alert after the window appears; WebDriver exposes it as a user prompt.
  const { sessionId } = await wd('POST', '/session', {
    capabilities: { alwaysMatch: { 'tauri:options': { application: APP, args: [path.join(fixtures, 'binary.md')] } } },
  });
  try {
    const end = Date.now() + 20_000;
    let msg = null;
    while (!msg && Date.now() < end) {
      try { msg = await wd('GET', `/session/${sessionId}/alert/text`); } catch { await new Promise((r) => setTimeout(r, 250)); }
    }
    assert.ok(msg && /not valid UTF-8/.test(msg), `alert text: ${JSON.stringify(msg)}`);
    await wd('POST', `/session/${sessionId}/alert/accept`, {}).catch(() => {});
  } finally { await wd('DELETE', `/session/${sessionId}`).catch(() => {}); }
});

test('window title and webview zoom permissions work through Tauri IPC', { skip }, async () => {
  const s = await openApp(path.join(REPO, 'test.md'));
  try {
    const title = await s.execAsync(`const done = arguments[arguments.length - 1];
      window.__TAURI__.window.getCurrentWindow().title().then(done, e => done('ERR ' + e));`);
    assert.equal(title, 'test.md — TCB, M.D.');
    const zoom = await s.execAsync(`const done = arguments[arguments.length - 1];
      window.__TAURI__.webview.getCurrentWebview().setZoom(1.1).then(() => done('ok'), e => done('ERR ' + e));`);
    assert.equal(zoom, 'ok');
    // Keyboard path: Ctrl+0 resets and persists through the same IPC call.
    await s.exec(`document.dispatchEvent(new KeyboardEvent('keydown', { key: '0', ctrlKey: true, bubbles: true }));`);
    assert.equal(await s.waitFor(`return localStorage.getItem('mdview.zoom');`, 'zoom persisted'), '1');
  } finally { await s.close(); }
});

test('Ctrl+E toggles edit mode and edits mark the document dirty', { skip }, async () => {
  const s = await openApp(path.join(REPO, 'test.md'));
  try {
    await s.exec(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'e', ctrlKey: true, bubbles: true }));`);
    assert.ok(await s.waitFor(`return document.body.classList.contains('mode-edit');`, 'edit mode'));
    await s.exec(`const e=document.getElementById('editor'); e.value += '\\nmore'; e.dispatchEvent(new Event('input'));`);
    const st = await s.exec(`return { dot: !document.getElementById('dirtyDot').hidden, title: document.title };`);
    assert.equal(st.dot, true);
    assert.ok(st.title.startsWith('• '), st.title);
  } finally { await s.close(); }
});
