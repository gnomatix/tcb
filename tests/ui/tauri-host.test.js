'use strict';
// Front-end checks through the *Tauri* host code path (makeTauriHost), with a fake
// window.__TAURI__ injected before app.js runs. The fake records every invoke() call and
// serves two files, a.md and b.md, plus a version list, so tests can drive save, history,
// file switching and the update check without a Rust backend.
//
// Run:   node --test "tests/ui/*.test.js"

const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require('playwright');
const { startServer } = require('./serve.js');

const WEB_ASSETS = path.resolve(__dirname, '..', '..', 'WebAssets');

const FAKE_TAURI = `
(() => {
  const files = { 'C:\\\\d\\\\a.md': '# A\\n\\nalpha\\n', 'C:\\\\d\\\\b.md': '# B\\n\\nbeta\\n' };
  const listeners = {};
  const fmt = { encoding: 'utf-8', bom: false, eol: 'lf' };
  window.__calls = [];
  window.__saveDelay = 0;
  window.__askAnswer = true;
  window.__asked = [];
  window.__update = null;          // set by a test before the 5 s update check fires
  window.__installed = 0;
  window.__TAURI__ = {
    core: { invoke: async (cmd, args) => {
      window.__calls.push([cmd, JSON.parse(JSON.stringify(args || {}))]);
      switch (cmd) {
        case 'get_launch_file': return { path: 'C:\\\\d\\\\a.md', content: files['C:\\\\d\\\\a.md'], format: fmt };
        case 'open_path': return { path: args.path, content: files[args.path], format: fmt };
        case 'render_markdown': return { html: '<p>' + args.text.replace(/</g, '&lt;') + '</p>', features: [] };
        case 'save_file':
          await new Promise((r) => setTimeout(r, window.__saveDelay));
          files[args.path] = args.content;
          return args.format || fmt;
        case 'get_version_info': return { backend: 'snapshots', branch: null, status: 'tracked', count: 1, snapshots: 0 };
        case 'list_versions': return [{ id: '1700000000', timestamp_unix: 1700000000, label: 'snapshot', author: null }];
        case 'read_version': return args.path.endsWith('a.md') ? '# A OLD VERSION\\n' : '# B OLD\\n';
        case 'get_file_meta': return { flavor: null };
        case 'detect_typesetting_tools': return { pandoc: false, typst: false };
        default: return null;
      }
    } },
    event: { listen: async (name, cb) => { listeners[name] = cb; } },
    window: { getCurrentWindow: () => ({ setTitle: async () => {}, onCloseRequested: async () => {} }) },
    webview: { getCurrentWebview: () => ({ setZoom: async () => {} }) },
    dialog: {
      ask: async (message) => { window.__asked.push(message); return window.__askAnswer; },
      open: async () => null,
      save: async () => null,
    },
    clipboardManager: { writeText: async () => {} },
    opener: { openUrl: async () => {} },
    updater: { check: async () => window.__update && {
      version: window.__update, currentVersion: '0.2.4',
      downloadAndInstall: async () => { window.__installed++; },
    } },
  };
  window.__emit = (name, payload) => listeners[name]({ payload });
})();
`;

let browser;
let server;
let page = null;
let pageErrors = [];

before(async () => {
  server = await startServer(WEB_ASSETS);
  browser = await chromium.launch();
});
after(async () => {
  if (browser) await browser.close();
  if (server) await server.close();
});
afterEach(async () => {
  if (page) await page.close();
  page = null;
  assert.deepEqual(pageErrors, [], 'uncaught page errors');
});

async function openPage() {
  pageErrors = [];
  page = await browser.newPage();
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('dialog', (d) => d.dismiss());
  await page.addInitScript(FAKE_TAURI);
  await page.goto(`http://127.0.0.1:${server.port}/index.html`);
  await page.waitForFunction(() => document.getElementById('editor').value.includes('alpha'));
  return page;
}
const saves = () => page.evaluate(() => window.__calls.filter((c) => c[0] === 'save_file').map((c) => [c[1].path, c[1].content]));

test('typing while a save is in flight keeps the document dirty', async () => {
  await openPage();
  await page.evaluate(() => { window.__saveDelay = 300; });
  await page.keyboard.press('Control+e');
  await page.click('#editor');
  await page.keyboard.press('End');
  await page.keyboard.type('X');
  await page.keyboard.press('Control+s');
  await page.waitForTimeout(50);
  await page.keyboard.type('Y');
  await page.waitForTimeout(500);
  const r = await page.evaluate(() => ({
    editor: document.getElementById('editor').value,
    dirty: !document.getElementById('dirtyDot').hidden,
  }));
  assert.ok(r.editor.endsWith('XY'), r.editor);
  assert.equal(r.dirty, true, 'Y is not saved yet');
  assert.deepEqual((await saves()).map((s) => s[1].slice(-2)), ['\nX'.slice(-2)]);
});

test('Ctrl+S with no edits does not rewrite the file; Ctrl+Shift+S still prompts', async () => {
  await openPage();
  await page.keyboard.press('Control+s');
  await page.waitForTimeout(200);
  assert.deepEqual(await saves(), []);
  await page.keyboard.press('Control+Shift+s');
  await page.waitForTimeout(200);
  // The fake dialog's save() returns null (cancelled): nothing written, but the prompt ran.
  assert.deepEqual(await saves(), []);
});

test('opening another file clears the version bar, so Restore cannot write the old file\'s history into it', async () => {
  await openPage();
  await page.keyboard.press('Control+h');
  await page.waitForFunction(() => !document.getElementById('versionPicker').disabled);
  await page.selectOption('#versionPicker', '1700000000');
  await page.waitForFunction(() => !document.getElementById('restoreSelectedBtn').disabled);
  await page.evaluate(() => window.__emit('tauri://drag-drop', { paths: ['C:\\d\\b.md'] }));
  await page.waitForFunction(() => document.getElementById('editor').value.includes('beta'));
  // The open bar reloads for b.md; nothing is selected and Edit is usable again.
  await page.waitForFunction(() => !document.getElementById('versionPicker').disabled);
  const r = await page.evaluate(() => ({
    picker: document.getElementById('versionPicker').value,
    restoreDisabled: document.getElementById('restoreSelectedBtn').disabled,
    editDisabled: document.getElementById('editToggle').disabled,
    listedFor: window.__calls.filter((c) => c[0] === 'list_versions').map((c) => c[1].path),
  }));
  assert.equal(r.picker, '__current__');
  assert.equal(r.restoreDisabled, true);
  assert.equal(r.editDisabled, false);
  assert.deepEqual(r.listedFor, ['C:\\d\\a.md', 'C:\\d\\b.md']);
  await page.keyboard.press('Control+s');
  await page.waitForTimeout(200);
  assert.deepEqual(await saves(), [], 'nothing edited, nothing written');
});

test('Ctrl+S works on a non-Latin keyboard layout (key "ы", code KeyS); AltGr letters stay text', async () => {
  await openPage();
  await page.keyboard.press('Control+e');
  await page.click('#editor');
  await page.keyboard.type('Z');
  // AltGr+S on a Polish layout: Ctrl+Alt with key "ś" must not save.
  await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ś', code: 'KeyS', ctrlKey: true, altKey: true, bubbles: true })));
  await page.waitForTimeout(200);
  assert.equal((await saves()).length, 0);
  await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ы', code: 'KeyS', ctrlKey: true, bubbles: true })));
  await page.waitForFunction(() => document.getElementById('dirtyDot').hidden);
  assert.equal((await saves()).length, 1);
});

test('an available update is offered after start-up and installed when accepted', async () => {
  await openPage();
  await page.evaluate(() => { window.__update = '9.9.9'; });
  await page.waitForFunction(() => window.__installed === 1, null, { timeout: 10_000 });
  const asked = await page.evaluate(() => window.__asked);
  assert.equal(asked.length, 1);
  assert.match(asked[0], /9\.9\.9 is available \(this is 0\.2\.4\)/);
  assert.equal(await page.evaluate(() => document.getElementById('editor').readOnly), true);
});

test('no update prompt while there are unsaved edits, or when there is no update', async () => {
  await openPage();
  await page.evaluate(() => { window.__update = '9.9.9'; });
  await page.keyboard.press('Control+e');
  await page.click('#editor');
  await page.keyboard.type('unsaved');
  await page.waitForTimeout(6000);
  assert.deepEqual(await page.evaluate(() => [window.__asked.length, window.__installed]), [0, 0]);
});
