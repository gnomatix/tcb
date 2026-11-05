'use strict';
// Browser-level smoke tests for the WebAssets front end running in "mock host" mode
// (no window.__TAURI__ → app.js uses makeMockHost()).
//
// Run:   node --test "tests/ui/*.test.js"      (npm run test:ui)
//        Node 22 treats a bare directory argument as a module path, so pass the glob.
// Needs: Node 22+, playwright (`npm i -D playwright`) and a Chromium build.
//        In this environment Chromium is pre-installed and `chromium.launch()` needs no options;
//        on other machines run `npx playwright install chromium` first.
//
// One browser is shared for the whole file; each test gets a fresh page. Page errors
// (uncaught exceptions) are collected on every page and asserted to be empty after each test.

const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require('playwright');
const { startServer } = require('./serve.js');

const WEB_ASSETS = path.resolve(__dirname, '..', '..', 'WebAssets');
const WELCOME_TIMEOUT = 10_000;

let browser;
let server;
let baseUrl;

// Per-test state (reset in openPage / afterEach).
let page = null;
let pageErrors = [];
let consoleMessages = [];

before(async () => {
  server = await startServer(WEB_ASSETS);
  baseUrl = `http://127.0.0.1:${server.port}`;
  browser = await chromium.launch();
});

after(async () => {
  if (browser) await browser.close();
  if (server) await server.close();
});

afterEach(async () => {
  const errors = pageErrors;
  if (page) {
    await page.close().catch(() => {});
    page = null;
  }
  assert.deepEqual(
    errors.map((e) => (e && e.message) || String(e)),
    [],
    'page threw uncaught exception(s)',
  );
});

/** Open a fresh page, load index.html and wait for the initial welcome render. */
async function openPage() {
  pageErrors = [];
  consoleMessages = [];
  page = await browser.newPage();
  page.on('pageerror', (err) => pageErrors.push(err));
  page.on('console', (msg) => consoleMessages.push(msg.text()));
  page.on('dialog', (d) => d.dismiss());
  await page.goto(`${baseUrl}/index.html`);
  await page.waitForFunction(
    () => (document.querySelector('#preview h1')?.textContent || '').includes('Welcome'),
    null,
    { timeout: WELCOME_TIMEOUT },
  );
  return page;
}

/** Resolve when a console message containing `substring` has been seen; reject on timeout. */
async function waitForConsole(substring, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = consoleMessages.find((t) => t.includes(substring));
    if (hit) return hit;
    if (Date.now() > deadline) {
      throw new assert.AssertionError({
        message:
          `no console message containing ${JSON.stringify(substring)} within ${timeoutMs}ms; ` +
          `saw: ${JSON.stringify(consoleMessages)}`,
      });
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function bodyHasClass(cls) {
  return page.evaluate((c) => document.body.classList.contains(c), cls);
}

/**
 * Snapshot of #dirtyDot: the app-controlled `hidden` property plus what the browser
 * actually renders. Both are reported so a CSS rule overriding `[hidden]` is obvious.
 */
async function dirtyDotState() {
  const dom = await page.evaluate(() => {
    const el = document.getElementById('dirtyDot');
    return { hidden: el.hidden, display: getComputedStyle(el).display };
  });
  return { ...dom, rendered: await page.locator('#dirtyDot').isVisible() };
}

async function assertDirtyDot(shouldShow, label) {
  const s = await dirtyDotState();
  const desc = `(hidden=${s.hidden}, computed display=${s.display}, rendered=${s.rendered})`;
  assert.equal(s.hidden, !shouldShow, `${label}: #dirtyDot.hidden should be ${!shouldShow} ${desc}`);
  assert.equal(
    s.rendered,
    shouldShow,
    `${label}: #dirtyDot should ${shouldShow ? '' : 'not '}be rendered ${desc}` +
      (!shouldShow && s.hidden && s.rendered
        ? ' — hidden attribute is set but a CSS display rule on .dirty-dot overrides [hidden]'
        : ''),
  );
}

async function enterEditModeViaLabel() {
  await page.locator('label.toggle').click();
  await page.waitForFunction(() => document.body.classList.contains('mode-edit'));
}

// ---------------------------------------------------------------------------

test('a. initial state: view mode, welcome preview, Save enabled, no dirty dot', async () => {
  await openPage();

  assert.equal(await bodyHasClass('mode-view'), true, 'body should have class mode-view');
  assert.equal(await bodyHasClass('mode-edit'), false, 'body should not have class mode-edit');
  assert.equal(await page.locator('#editor').isHidden(), true, '#editor should be hidden');
  assert.match(await page.locator('#preview h1').textContent(), /Welcome/, 'preview shows welcome heading');
  await assertDirtyDot(false, 'initial');
  assert.equal(
    await page.locator('#saveBtn').isEnabled(),
    true,
    '#saveBtn should be enabled with no path open (Save acts as Save As)',
  );
});

test('b. clicking the Edit toggle label enters edit mode and focuses the editor', async () => {
  await openPage();

  await enterEditModeViaLabel();

  assert.equal(await bodyHasClass('mode-edit'), true, 'body should have class mode-edit');
  assert.equal(await bodyHasClass('mode-view'), false, 'body should not have class mode-view');
  assert.equal(await page.locator('#editor').isVisible(), true, '#editor should be visible');
  assert.equal(
    await page.evaluate(() => document.activeElement && document.activeElement.id),
    'editor',
    '#editor should be focused',
  );
});

test('c. Control+E toggles edit mode on and off', async () => {
  await openPage();

  await page.keyboard.press('Control+e');
  assert.equal(await bodyHasClass('mode-edit'), true, 'after first Ctrl+E body should have mode-edit');
  assert.equal(await bodyHasClass('mode-view'), false, 'after first Ctrl+E body should not have mode-view');

  await page.keyboard.press('Control+e');
  assert.equal(await bodyHasClass('mode-view'), true, 'after second Ctrl+E body should have mode-view');
  assert.equal(await bodyHasClass('mode-edit'), false, 'after second Ctrl+E body should not have mode-edit');
});

test('d. typing marks the document dirty; restoring original content makes it clean', async () => {
  await openPage();
  await enterEditModeViaLabel();

  const editor = page.locator('#editor');
  await editor.pressSequentially('hello');

  await assertDirtyDot(true, 'after typing');
  assert.ok((await page.title()).startsWith('• '), `document.title should start with "• " (was ${JSON.stringify(await page.title())})`);
  const dirtyTitle = await page.locator('#docTitle').textContent();
  assert.ok(dirtyTitle.endsWith(' •'), `#docTitle should end with " •" (was ${JSON.stringify(dirtyTitle)})`);

  // Select all and delete → back to the original (empty) content → clean again.
  await editor.press('Control+a');
  await editor.press('Backspace');
  assert.equal(await editor.inputValue(), '', 'editor should be empty again');

  assert.ok(!(await page.title()).startsWith('• '), 'document.title should not start with "• " when clean');
  const cleanTitle = await page.locator('#docTitle').textContent();
  assert.ok(!cleanTitle.endsWith(' •'), `#docTitle should not end with " •" when clean (was ${JSON.stringify(cleanTitle)})`);
  await assertDirtyDot(false, 'after restoring original content');
});

test('e. feature badges: typing a GFM table does not throw; mock host reports no features', async () => {
  await openPage();
  await enterEditModeViaLabel();

  const table = '| a | b |\n|---|---|\n| 1 | 2 |\n';
  const editor = page.locator('#editor');
  await editor.pressSequentially(table);

  assert.equal(await editor.inputValue(), table, 'editor should contain the typed table');

  // Flip back to view so the preview re-renders from the editor (badges come from renderMarkdown).
  await page.locator('label.toggle').click();
  await page.waitForFunction(() => document.body.classList.contains('mode-view'));

  assert.equal(
    (await page.locator('#features').textContent()).trim(),
    '',
    '#features should stay empty in mock mode (features are always [])',
  );
  assert.deepEqual(pageErrors, [], 'no page errors while typing/rendering a table');
});

test('f. Control+Shift+S triggers Save As in the mock host and clears the dirty state', async () => {
  await openPage();
  await enterEditModeViaLabel();

  await page.locator('#editor').pressSequentially('# Draft\n');
  await assertDirtyDot(true, 'precondition: document is dirty');

  await page.keyboard.press('Control+Shift+s');
  await waitForConsole('[host:mock] would saveAs');

  await page.waitForFunction(() => document.getElementById('dirtyDot').hidden, null, { timeout: 3000 });
  await assertDirtyDot(false, 'after Save As');
  assert.equal(
    (await page.locator('#docTitle').textContent()).trim(),
    'untitled.md',
    '#docTitle should read "untitled.md" after mock Save As',
  );
});

test('f2. Control+O and the Open button ask the host for a file picker', async () => {
  await openPage();

  await page.keyboard.press('Control+o');
  await waitForConsole('[host:mock] would open a file picker');

  consoleMessages.length = 0;
  await page.locator('#openBtn').click();
  await waitForConsole('[host:mock] would open a file picker');
  // Mock picker returns null → nothing opened, document untouched.
  assert.equal((await page.locator('#docTitle').textContent()).trim(), 'untitled.md');
});

test('g. About dialog opens from the toolbar button and closes on Escape', async () => {
  await openPage();

  await page.locator('#aboutToggle').click();
  assert.equal(await page.locator('#aboutOverlay').isVisible(), true, '#aboutOverlay should be shown');

  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#aboutOverlay').isHidden(), true, '#aboutOverlay should be hidden after Escape');
});

test('h. Control+H shows the version bar with "No file open"; Escape closes it', async () => {
  await openPage();

  await page.keyboard.press('Control+h');
  assert.equal(await page.locator('#versionBar').isVisible(), true, '#versionBar should be shown');
  const optionTexts = await page.locator('#versionPicker option').allTextContents();
  assert.ok(
    optionTexts.some((t) => t.trim() === 'No file open'),
    `#versionPicker should offer "No file open" (options: ${JSON.stringify(optionTexts)})`,
  );

  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#versionBar').isHidden(), true, '#versionBar should be hidden after Escape');
});

test('i. Print View paginates with paged.js and closes via the × button', async () => {
  await openPage();

  await page.locator('#printViewToggle').click();
  assert.equal(await bodyHasClass('mode-print-view'), true, 'body should have class mode-print-view');

  const status = page.locator('#printViewStatus');
  const PAGES_RE = /\d+ pages?/;
  let statusText = '';
  try {
    await page.waitForFunction(
      () => /\d+ pages?/.test(document.getElementById('printViewStatus').textContent || ''),
      null,
      { timeout: 10_000 },
    );
  } catch (_) {
    // Fall through: the assertion below reports the actual status text instead of hanging.
  }
  statusText = (await status.textContent()) || '';
  assert.match(statusText, PAGES_RE, `#printViewStatus should report a page count; got ${JSON.stringify(statusText)}`);

  await page.locator('#printViewClose').click();
  assert.equal(await bodyHasClass('mode-print-view'), false, 'body should drop mode-print-view after close');
});
