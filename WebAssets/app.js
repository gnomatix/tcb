// Minimal Markdown editor — WebView payload.
// Talks to a host shell (Tauri 2, or vanilla browser for development).
// The host is abstracted behind a tiny interface so this file is portable.

(() => {
  // markdown-it is used only in the browser mock (vanilla Chrome testing). In Tauri,
  // rendering goes through the Rust pulldown-cmark command which also returns detected
  // features for the badge row.
  const md = window.markdownit({
    html: false,
    linkify: true,
    typographer: true,
    breaks: false,
  });

  // DOM
  const $body          = document.body;
  const $title         = document.getElementById('docTitle');
  const $dirtyDot      = document.getElementById('dirtyDot');
  const $features      = document.getElementById('features');
  const $flavorSelect  = document.getElementById('flavorSelect');
  const $flavorWarn    = document.getElementById('flavorWarn');
  const $statusbarBtn      = document.getElementById('statusbarToggle');
  const $versionInfo       = document.getElementById('versionInfo');
  const $fileFormat        = document.getElementById('fileFormat');
  const $versionBarToggle  = document.getElementById('versionBarToggle');
  const $versionBar        = document.getElementById('versionBar');
  const $versionPicker     = document.getElementById('versionPicker');
  const $versionMeta       = document.getElementById('versionMeta');
  const $backupFirst       = document.getElementById('backupFirst');
  const $restoreSelectedBtn = document.getElementById('restoreSelectedBtn');
  const $printViewToggle   = document.getElementById('printViewToggle');
  const $printView         = document.getElementById('printView');
  const $printPages        = document.getElementById('printPages');
  const $printViewStatus   = document.getElementById('printViewStatus');
  const $printSize         = document.getElementById('printSize');
  const $printNowBtn       = document.getElementById('printNowBtn');
  const $printViewClose    = document.getElementById('printViewClose');
  const $typesetToggle     = document.getElementById('typesetToggle');
  const $exportPdfBtn      = document.getElementById('exportPdfBtn');
  const $toggle        = document.getElementById('editToggle');
  const $saveBtn       = document.getElementById('saveBtn');
  const $preview       = document.getElementById('preview');
  const $editor        = document.getElementById('editor');
  const $aboutToggle   = document.getElementById('aboutToggle');
  const $aboutOverlay  = document.getElementById('aboutOverlay');
  const $aboutClose    = document.getElementById('aboutClose');
  const $aboutVersion  = document.getElementById('aboutVersion');
  const $bmacQr        = document.getElementById('bmacQr');

  // ------------------------------------------------------------------
  // Markdown flavor support matrix.
  // Maps detected-feature label -> which flavor(s) support it.
  // `null` means the flavor has no validation (i.e. anything goes).
  // Keep these sets in sync with the detector labels in src-tauri/src/lib.rs.
  // ------------------------------------------------------------------
  // `pagebreaks` is an HTML comment (`<!-- pagebreak -->`), legal in every flavor
  // including CommonMark, so it is never flagged.
  const FLAVOR_SUPPORT = {
    any:           null,
    commonmark:    new Set(['pagebreaks']),
    gfm:           new Set(['tables', 'tasklists', 'strikethrough', 'footnotes', 'github-alerts', 'pagebreaks']),
    pandoc:        new Set(['tables', 'tasklists', 'strikethrough', 'footnotes', 'math',
                            'heading-attrs', 'fenced-divs', 'definitions', 'citations', 'frontmatter', 'pagebreaks']),
    multimarkdown: new Set(['tables', 'footnotes', 'math', 'heading-attrs', 'definitions',
                            'citations', 'frontmatter', 'pagebreaks']),
    obsidian:      new Set(['tables', 'tasklists', 'strikethrough', 'footnotes', 'github-alerts',
                            'math', 'wikilinks', 'frontmatter', 'pagebreaks']),
  };
  const FLAVOR_KEY = 'mdview.flavor';
  $flavorSelect.value = localStorage.getItem(FLAVOR_KEY) || 'gfm';
  let lastFeatures = [];

  // State
  const state = {
    path: null,            // Absolute file path provided by host, or null for unsaved doc.
    savedContent: '',      // Content as-of last load or save. Used for dirty detection.
    isDirty: false,
    // On-disk text format reported by the host at load time ({encoding, bom, eol}).
    // Handed back on save so CRLF / BOM / UTF-16 files round-trip byte-for-byte.
    // null = new document → host default (UTF-8, no BOM, LF).
    format: null,
  };
  const MARKDOWN_FILTERS = [{ name: 'Markdown', extensions: ['md', 'markdown'] }];

  // ------------------------------------------------------------------
  // Host bridge — selects implementation based on environment.
  // ------------------------------------------------------------------
  const host = makeHost();

  function makeHost() {
    if (window.__TAURI__) return makeTauriHost();
    return makeMockHost();
  }

  function makeTauriHost() {
    const { invoke } = window.__TAURI__.core;
    const { listen } = window.__TAURI__.event;
    const clipboard = window.__TAURI__.clipboardManager;
    const currentWindow = window.__TAURI__.window?.getCurrentWindow?.();
    return {
      kind: 'tauri',
      async init({ onOpen, onOpenPath, onOpenError, onCloseRequested }) {
        // Second instance launched with a file → single-instance plugin forwards the path.
        await listen('open-file', (e) => {
          const path = typeof e.payload === 'string' ? e.payload : e.payload?.path;
          if (path) onOpenPath(path);
        });
        // File dropped onto the window (Tauri emits paths; we take the first markdown-ish one).
        await listen('tauri://drag-drop', (e) => {
          const paths = e.payload?.paths || [];
          const path = paths.find((p) => /\.(md|markdown|txt)$/i.test(p)) || paths[0];
          if (path) onOpenPath(path);
        });
        // Intercept the OS close button so unsaved edits can be confirmed. Requires
        // `core:window:allow-destroy` (the JS API destroys the window when not prevented).
        // Rust prevents the close whenever a JS listener exists, so the handler must never
        // throw — otherwise destroy() is skipped and the X button stops working.
        if (currentWindow?.onCloseRequested) {
          try {
            await currentWindow.onCloseRequested(async (event) => {
              let proceed = true;
              try {
                proceed = await onCloseRequested();
              } catch (err) {
                console.error('[close] guard failed:', err);
                // Dialog plugin unavailable: never discard edits silently.
                proceed = !state.isDirty || window.confirm('You have unsaved changes. Close without saving?');
              }
              if (!proceed) event.preventDefault();
            });
          } catch (err) {
            console.warn('[host] close-requested hook unavailable:', err);
          }
        }
        // Load the launch file BEFORE showing the window (no blank flash), but report a
        // failure only AFTER it is visible — a modal alert on a hidden window looks hung.
        let launch = null;
        let launchError = null;
        try {
          launch = await invoke('get_launch_file');
        } catch (err) {
          launchError = err;
        }
        if (launch) {
          try { await onOpen(launch); } catch (err) { console.error('[host:init] applying launch file failed:', err); }
        }
        await invoke('frontend_ready');
        if (launchError) onOpenError(launchError);
      },
      async openPath(path) {
        return await invoke('open_path', { path });
      },
      async setWindowTitle(title) {
        if (currentWindow?.setTitle) await currentWindow.setTitle(title);
      },
      async setZoom(factor) {
        // Needs `core:webview:allow-set-webview-zoom`. Native zoom hotkeys are disabled in
        // tauri.conf.json so this is the single owner of the zoom level.
        const webview = window.__TAURI__.webview?.getCurrentWebview?.();
        if (webview?.setZoom) await webview.setZoom(factor);
      },
      async openFile() {
        const { open } = window.__TAURI__.dialog;
        const picked = await open({ multiple: false, directory: false, filters: MARKDOWN_FILTERS });
        const path = Array.isArray(picked) ? picked[0] : picked;
        if (!path) return null;
        return await invoke('open_path', { path });
      },
      async save(path, content, format) {
        const written = await invoke('save_file', { path, content, format });
        return { path, format: written };
      },
      async saveAs(content, format, defaultPath) {
        const { save } = window.__TAURI__.dialog;
        const path = await save({
          defaultPath: defaultPath || 'untitled.md',
          filters: MARKDOWN_FILTERS,
        });
        if (!path) return null;
        const written = await invoke('save_file', { path, content, format });
        return { path, format: written };
      },
      async copyText(text) {
        await clipboard.writeText(text);
      },
      async openExternal(url) {
        // Default browser / mail client. Needs `opener:default` (http, https, mailto, tel).
        await window.__TAURI__.opener.openUrl(url);
      },
      async renderMarkdown(text) {
        // Rust pulldown-cmark with all extensions + HTML escaping + feature detection.
        return await invoke('render_markdown', { text });
      },
      async confirm(message, opts) {
        const { ask } = window.__TAURI__.dialog;
        return await ask(message, opts);
      },
      async getVersionInfo(path) {
        return await invoke('get_version_info', { path });
      },
      async listVersions(path) {
        return await invoke('list_versions', { path });
      },
      async readVersion(path, id) {
        return await invoke('read_version', { path, id });
      },
      async diffText(oldText, newText) {
        return await invoke('diff_text', { old: oldText, new: newText });
      },
      async getFileMeta(path) {
        return await invoke('get_file_meta', { path });
      },
      async setFileMeta(path, meta) {
        return await invoke('set_file_meta', { path, meta });
      },
      async snapshotCurrent(path, content) {
        return await invoke('snapshot_current', { path, content });
      },
      async detectTypesettingTools() {
        return await invoke('detect_typesetting_tools');
      },
      async exportTypesetPdf(input, output) {
        return await invoke('export_typeset_pdf', { input, output });
      },
      async pickSavePdfPath(defaultPath) {
        const { save } = window.__TAURI__.dialog;
        return await save({
          defaultPath,
          filters: [{ name: 'PDF', extensions: ['pdf'] }],
        });
      },
    };
  }

  function makeMockHost() {
    console.info('[host] no Tauri detected — running in browser mock mode.');
    const MOCK_FORMAT = { encoding: 'utf-8', bom: false, eol: 'lf' };
    return {
      kind: 'mock',
      async init({ onCloseRequested }) {
        // Browser equivalent of the close guard: the native beforeunload prompt.
        window.addEventListener('beforeunload', (e) => {
          if (state.isDirty) { e.preventDefault(); e.returnValue = ''; }
        });
        void onCloseRequested;
      },
      async setWindowTitle() {/* document.title is the window title in a browser */},
      async setZoom(factor) {
        document.documentElement.style.zoom = String(factor);
      },
      async openFile() {
        console.info('[host:mock] would open a file picker');
        return null;
      },
      async openPath(path) {
        throw new Error('mock host cannot read ' + path);
      },
      async save(path, content, format) {
        console.info('[host:mock] would save', path, content.length, 'bytes', format || MOCK_FORMAT);
        return { path, format: format || MOCK_FORMAT };
      },
      async saveAs(content, format) {
        console.info('[host:mock] would saveAs', content.length, 'bytes');
        return { path: 'untitled.md', format: format || MOCK_FORMAT };
      },
      async copyText(text) {
        if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
        else console.info('[host:mock] would copy', text);
      },
      async openExternal(url) {
        window.open(url, '_blank', 'noopener');
      },
      async renderMarkdown(text) {
        return { html: md.render(text), features: [] };
      },
      async confirm(message) {
        return window.confirm(message);
      },
      async getVersionInfo() {
        return null;
      },
      async listVersions() {
        return [];
      },
      async readVersion() {
        return '';
      },
      async diffText(oldText, newText) {
        // Mock-mode fallback: trivial line-based diff so the UI is testable in vanilla Chrome.
        const a = oldText.split('\n');
        const b = newText.split('\n');
        const out = ['--- older', '+++ current', '@@'];
        const max = Math.max(a.length, b.length);
        for (let i = 0; i < max; i++) {
          if (a[i] === b[i]) out.push(' ' + (a[i] ?? ''));
          else {
            if (a[i] !== undefined) out.push('-' + a[i]);
            if (b[i] !== undefined) out.push('+' + b[i]);
          }
        }
        return out.join('\n');
      },
      async getFileMeta() {
        return { flavor: null };
      },
      async setFileMeta() {
        /* no-op */
      },
      async snapshotCurrent() {
        /* no-op */
      },
      async detectTypesettingTools() {
        return { pandoc: false, typst: false };
      },
      async exportTypesetPdf() {
        throw new Error('Typeset PDF export needs Tauri.');
      },
      async pickSavePdfPath() {
        return null;
      },
    };
  }

  // ------------------------------------------------------------------
  // Load / save flow
  // ------------------------------------------------------------------
  async function applyLoadedFile({ path, content, format }) {
    state.path = path || null;
    state.savedContent = content || '';
    state.format = format || null;
    $editor.value = state.savedContent;
    setDirty(false);
    renderFileFormat();
    await applyFileFlavorPreference();   // adjust dropdown BEFORE render so badges use right flavor
    await renderPreview(state.savedContent);
    refreshVersionInfo();
  }

  /** Opening a new file over unsaved edits: confirm first. Returns true to proceed. */
  async function confirmDiscardIfDirty(action) {
    if (!state.isDirty) return true;
    return await host.confirm(
      `You have unsaved changes. ${action} and discard them?`,
      { title: 'Unsaved changes', kind: 'warning' },
    );
  }

  function reportOpenError(err) {
    console.error('[open] failed:', err);
    alert('Could not open file:\n\n' + (err?.message || err));
  }

  /** Open a host-supplied path (drag-drop, second instance) with the same unsaved-edits
   *  confirmation as Ctrl+O. */
  async function openPathGuarded(path) {
    try {
      if (!(await confirmDiscardIfDirty('Open another file'))) return;
      await applyLoadedFile(await host.openPath(path));
    } catch (err) {
      reportOpenError(err);
    }
  }

  async function openFileViaDialog() {
    try {
      if (!(await confirmDiscardIfDirty('Open another file'))) return;
      const file = await host.openFile();
      if (file) await applyLoadedFile(file);
    } catch (err) {
      reportOpenError(err);
    }
  }

  /** Window close guard: true = allow close, false = keep the window open. */
  async function onCloseRequested() {
    if (!state.isDirty) return true;
    return await host.confirm(
      'You have unsaved changes. Close without saving?',
      { title: 'Unsaved changes', kind: 'warning' },
    );
  }

  const FORMAT_LABEL = { 'utf-8': 'UTF-8', 'utf-16le': 'UTF-16 LE', 'utf-16be': 'UTF-16 BE' };
  function renderFileFormat() {
    if (!$fileFormat) return;
    const f = state.format;
    if (!f) {
      $fileFormat.textContent = '';
      $fileFormat.title = '';
      return;
    }
    const enc = (FORMAT_LABEL[f.encoding] || f.encoding) + (f.bom && f.encoding === 'utf-8' ? ' BOM' : '');
    $fileFormat.textContent = `${(f.eol || 'lf').toUpperCase()} · ${enc}`;
    $fileFormat.title = 'Line endings and encoding detected on load — preserved on save';
  }

  async function applyFileFlavorPreference() {
    if (!state.path) return;
    try {
      const meta = await host.getFileMeta(state.path);
      if (meta && meta.flavor && FLAVOR_SUPPORT[meta.flavor] !== undefined) {
        $flavorSelect.value = meta.flavor;
      }
    } catch (err) {
      console.error('[file-meta] load failed:', err);
    }
  }

  async function refreshVersionInfo() {
    if (!state.path) {
      $versionInfo.textContent = '';
      $versionInfo.removeAttribute('data-status');
      $versionInfo.title = '';
      return;
    }
    try {
      const info = await host.getVersionInfo(state.path);
      if (!info) {
        $versionInfo.textContent = '';
        $versionInfo.removeAttribute('data-status');
        return;
      }
      if (info.backend === 'git') {
        const parts = [`git: ${info.branch || '?'}`, info.status];
        if (info.count > 0) parts.push(`${info.count} commit${info.count === 1 ? '' : 's'}`);
        if (info.snapshots > 0) parts.push(`${info.snapshots} snapshot${info.snapshots === 1 ? '' : 's'}`);
        $versionInfo.textContent = parts.join(' · ');
        $versionInfo.title =
          `Backend: git\nBranch: ${info.branch}\nFile status: ${info.status}\n${info.count} commit(s) touched this file` +
          (info.snapshots > 0 ? `\n${info.snapshots} local backup snapshot(s) also listed in the version bar` : '');
      } else if (info.backend === 'snapshots') {
        $versionInfo.textContent = `snapshots: ${info.count}`;
        $versionInfo.title =
          `Backend: local snapshots (file is not in a git repo)\n${info.count} snapshot(s) stored in app_data_dir/snapshots/`;
      } else {
        $versionInfo.textContent = '';
      }
      if (info.status) $versionInfo.dataset.status = info.status;
      else $versionInfo.removeAttribute('data-status');
    } catch (err) {
      console.error('[version] failed:', err);
    }
  }

  async function save({ forcePrompt = false } = {}) {
    const content = $editor.value;

    // Flavor compatibility gate: if features are present that the target flavor
    // doesn't support, get explicit confirmation before writing the bytes.
    const flavor = $flavorSelect.value;
    const support = FLAVOR_SUPPORT[flavor];
    const incompatible = support ? lastFeatures.filter((f) => !support.has(f)) : [];
    if (incompatible.length > 0) {
      const proceed = await host.confirm(
        `This file uses ${incompatible.length} feature${incompatible.length === 1 ? '' : 's'} ` +
        `not in ${flavor}:\n\n  • ${incompatible.join('\n  • ')}\n\n` +
        `Save anyway? (No source transformation is performed — the bytes are written as-is.)`,
        { title: 'Flavor compatibility', kind: 'warning' },
      );
      if (!proceed) return;
    }

    try {
      const result = state.path && !forcePrompt
        ? await host.save(state.path, content, state.format)
        : await host.saveAs(content, state.format, state.path || undefined);
      if (!result) return;            // User cancelled saveAs dialog.
      state.path = result.path;
      state.savedContent = content;
      if (result.format) state.format = result.format;
      setDirty(false);
      renderFileFormat();
      refreshVersionInfo();           // count + status may have changed.
    } catch (err) {
      console.error('[save] failed:', err);
      alert('Save failed: ' + (err?.message || err));
    }
  }

  // ------------------------------------------------------------------
  // Render
  // ------------------------------------------------------------------
  // Renders are async (IPC round trip). Only the most recently requested render may
  // touch the DOM, so a slow debounced render cannot overwrite a newer one.
  let renderSeq = 0;
  async function renderPreview(text) {
    const seq = ++renderSeq;
    try {
      const { html, features } = await host.renderMarkdown(text || '');
      if (seq !== renderSeq) return;   // superseded
      $preview.innerHTML = html;
      addHeadingIds($preview);
      renderFeatureBadges(features);
      await renderMathIfPresent($preview);
    } catch (err) {
      console.error('[render] failed:', err);
    }
  }

  // ------------------------------------------------------------------
  // Links inside the preview
  //
  // The preview is a WebView: left alone, an `https://` link replaces the whole app with
  // the web page (no way back), a relative `other.md` 404s inside the app origin and a
  // `#heading` anchor only works if the heading happens to carry an id. One delegated
  // click listener on #preview always calls preventDefault() and routes the link:
  //   #fragment        → scroll the matching heading into view
  //   other.md         → open that file in this app (relative to the open document)
  //   http/https/mailto→ default browser / mail client via the host
  //   anything else    → swallowed and logged
  // Middle-click, Ctrl/Shift/Alt/Meta-click are swallowed too (nothing happens): there is
  // no second tab or window to open into, and letting the WebView handle them is the bug
  // this fixes. The decision itself is the pure `classifyLink()` below (exposed for tests).
  // ------------------------------------------------------------------

  /** GitHub-style heading slug: lower-case, drop punctuation other than `-`/`_`, spaces → `-`. */
  function slugify(text) {
    return String(text)
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, '')
      .replace(/\s+/g, '-');
  }

  /** Give every heading an id (slug of its text, `-1`, `-2` … on repeats) unless the
   *  renderer already emitted one (pulldown-cmark does for `## Title {#id}`). */
  function addHeadingIds(container) {
    const seen = new Set();
    for (const h of container.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
      if (h.id) { seen.add(h.id); continue; }
      const base = slugify(h.textContent) || 'section';
      let id = base;
      for (let n = 1; seen.has(id); n++) id = `${base}-${n}`;
      seen.add(id);
      h.id = id;
    }
  }

  /** Join a directory and a relative path, collapsing `.` / `..`, keeping the directory's
   *  separator style (`\` on Windows paths). The root (`C:` or POSIX `/`) is never popped. */
  function joinRelativePath(baseDir, rel) {
    const sep = baseDir.includes('\\') ? '\\' : '/';
    const parts = baseDir.split(/[\\/]/);
    if (parts.length > 1 && parts[parts.length - 1] === '') parts.pop();   // "C:\" / "/"
    for (const seg of rel.split(/[\\/]/)) {
      if (seg === '' || seg === '.') continue;
      if (seg === '..') { if (parts.length > 1) parts.pop(); continue; }
      parts.push(seg);
    }
    return parts.join(sep);
  }

  const EXTERNAL_SCHEMES = new Set(['http:', 'https:', 'mailto:']);
  const MARKDOWN_FILE_RE = /\.(md|markdown)$/i;
  const SCHEME_RE = /^([a-zA-Z][a-zA-Z0-9+.-]*):/;
  const WIN_DRIVE_RE = /^[a-zA-Z]:[\\/]/;

  /**
   * Decide what a click on `href` (as written in the Markdown) should do.
   * Pure: no DOM, no state. Returns {kind, target[, fragment]} where kind is
   *   'fragment' — target is the decoded fragment (no `#`)
   *   'markdown' — target is the absolute path to open (null when no file is open, so a
   *                relative link has nothing to resolve against); fragment is any `#…` part
   *   'external' — target is the URL to hand to the OS
   *   'ignore'   — target is the original href; nothing should happen
   */
  function classifyLink(href, currentPath) {
    const raw = String(href ?? '').trim();
    if (!raw) return { kind: 'ignore', target: raw };

    if (raw.startsWith('#')) {
      return { kind: 'fragment', target: safeDecode(raw.slice(1)) };
    }

    const scheme = SCHEME_RE.exec(raw);
    if (scheme && !WIN_DRIVE_RE.test(raw)) {
      const s = scheme[1].toLowerCase() + ':';
      if (EXTERNAL_SCHEMES.has(s)) return { kind: 'external', target: raw };
      return { kind: 'ignore', target: raw };           // file:, javascript:, data:, …
    }
    if (raw.startsWith('//')) return { kind: 'ignore', target: raw };   // protocol-relative URL

    const hashAt = raw.indexOf('#');
    const fragment = hashAt >= 0 ? safeDecode(raw.slice(hashAt + 1)) : null;
    let filePart = hashAt >= 0 ? raw.slice(0, hashAt) : raw;
    const queryAt = filePart.indexOf('?');
    if (queryAt >= 0) filePart = filePart.slice(0, queryAt);
    filePart = safeDecode(filePart);
    if (!MARKDOWN_FILE_RE.test(filePart)) return { kind: 'ignore', target: raw };

    const absolute = WIN_DRIVE_RE.test(filePart) || /^[\\/]/.test(filePart);
    if (absolute) return { kind: 'markdown', target: filePart, fragment };
    if (!currentPath) return { kind: 'markdown', target: null, fragment };
    return { kind: 'markdown', target: joinRelativePath(parentDir(currentPath), filePart), fragment };
  }

  function safeDecode(s) {
    try { return decodeURIComponent(s); } catch (_) { return s; }
  }

  function scrollToFragment(fragment) {
    if (!fragment) return false;
    const want = slugify(fragment);
    let el = null;
    for (const h of $preview.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
      if (h.id === fragment || h.id === want || slugify(h.textContent) === want) { el = h; break; }
    }
    if (!el) {
      console.info('[link] no heading matches', '#' + fragment);
      return false;
    }
    el.scrollIntoView({ block: 'start' });
    return true;
  }

  async function followPreviewLink(href) {
    const link = classifyLink(href, state.path);
    switch (link.kind) {
      case 'fragment':
        scrollToFragment(link.target);
        return;
      case 'markdown':
        if (!link.target) {
          console.info('[link] no file open; cannot resolve relative link', href);
          return;
        }
        await openPathGuarded(link.target);
        if (link.fragment && state.path === link.target) scrollToFragment(link.fragment);
        return;
      case 'external':
        try {
          await host.openExternal(link.target);
        } catch (err) {
          console.error('[link] open external failed:', err);
        }
        return;
      default:
        console.info('[link] ignored', href);
    }
  }

  function onPreviewClick(e) {
    const a = e.target instanceof Element ? e.target.closest('a[href]') : null;
    if (!a || !$preview.contains(a)) return;
    e.preventDefault();                       // the WebView itself must never navigate
    if (e.type !== 'click' || e.button !== 0) return;
    if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    followPreviewLink(a.getAttribute('href'));
  }
  $preview.addEventListener('click', onPreviewClick);
  $preview.addEventListener('auxclick', onPreviewClick);   // middle button fires auxclick, not click

  // Test hook: the pure routing decision, callable from the Playwright suite.
  window.tcbLinks = Object.freeze({ classifyLink, slugify, joinRelativePath });

  // ----- KaTeX (lazy-loaded; runs over .math.math-inline / .math-display spans
  //       produced by pulldown-cmark's ENABLE_MATH) -----
  let katexLoading = null;
  async function ensureKatex() {
    if (window.katex) return;
    if (katexLoading) return katexLoading;
    katexLoading = (async () => {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = 'vendor/katex/katex.min.css';
      document.head.appendChild(link);
      await loadScriptOnce('vendor/katex/katex.min.js');
    })();
    return katexLoading;
  }
  function loadScriptOnce(src) {
    return new Promise((resolve, reject) => {
      const el = document.createElement('script');
      el.src = src;
      el.onload = () => resolve();
      el.onerror = () => reject(new Error('failed to load: ' + src));
      document.head.appendChild(el);
    });
  }
  async function renderMathIfPresent(container) {
    const spans = container.querySelectorAll('span.math');
    if (!spans.length) return;
    try {
      await ensureKatex();
      for (const el of spans) {
        const display = el.classList.contains('math-display');
        try {
          window.katex.render(el.textContent, el, { displayMode: display, throwOnError: false });
        } catch (err) {
          console.warn('[katex] render failed:', err);
        }
      }
    } catch (err) {
      console.error('[katex] load failed:', err);
    }
  }

  function renderFeatureBadges(features) {
    lastFeatures = features;
    const flavor = $flavorSelect.value;
    const support = FLAVOR_SUPPORT[flavor];
    const incompatible = [];

    $features.innerHTML = '';
    for (const label of features) {
      const span = document.createElement('span');
      span.className = 'feature-badge';
      span.textContent = label;
      if (support && !support.has(label)) {
        span.classList.add('feature-badge--incompatible');
        span.title = `Not supported by ${flavor}`;
        incompatible.push(label);
      } else {
        span.title = `Supported by ${flavor}`;
      }
      $features.appendChild(span);
    }

    if (incompatible.length > 0) {
      $flavorWarn.hidden = false;
      $flavorWarn.textContent =
        `⚠ ${incompatible.length} feature${incompatible.length === 1 ? '' : 's'} not in ${flavor}`;
    } else {
      $flavorWarn.hidden = true;
      $flavorWarn.textContent = '';
    }
  }

  $flavorSelect.addEventListener('change', () => {
    try { localStorage.setItem(FLAVOR_KEY, $flavorSelect.value); } catch (_) {/* ignore */}
    if (state.path) {
      host.setFileMeta(state.path, { flavor: $flavorSelect.value })
        .catch((err) => console.error('[file-meta] save failed:', err));
    }
    renderFeatureBadges(lastFeatures);   // restyle without re-rendering markdown
  });

  // ------------------------------------------------------------------
  // Mode toggle
  // ------------------------------------------------------------------
  $toggle.addEventListener('change', () => {
    if ($toggle.checked) enterEditMode();
    else                 enterViewMode();
  });

  function enterEditMode() {
    $body.classList.remove('mode-view');
    $body.classList.add('mode-edit');
    $editor.hidden = false;
    $editor.focus();
  }

  function enterViewMode() {
    // Save-on-toggle policy: edits stay in memory (never auto-written). The dirty dot,
    // the "•" in the title and the close-window guard make unsaved state visible, and
    // Ctrl+S / Save commit it explicitly. Auto-saving on toggle would write half-done
    // edits into git working trees without the user asking for it.
    cancelScheduledRender();
    renderPreview($editor.value);
    $body.classList.remove('mode-edit');
    $body.classList.add('mode-view');
    $editor.hidden = true;
  }

  function toggleEditMode() {
    if ($toggle.disabled) return;      // A past version is selected in the version bar.
    $toggle.checked = !$toggle.checked;
    $toggle.dispatchEvent(new Event('change'));
  }

  // ------------------------------------------------------------------
  // Editor change handling
  // ------------------------------------------------------------------
  // Re-render strategy: debounced. The preview itself is hidden while editing, but
  // the render also drives the feature badges and the flavor-compatibility warning in
  // the status bar, so those stay current as you type without re-parsing on every key.
  const RENDER_DEBOUNCE_MS = 350;
  let renderTimer = null;
  function scheduleRender() {
    cancelScheduledRender();
    renderTimer = setTimeout(() => {
      renderTimer = null;
      if ($body.classList.contains('mode-edit')) renderPreview($editor.value);
    }, RENDER_DEBOUNCE_MS);
  }
  function cancelScheduledRender() {
    if (renderTimer !== null) { clearTimeout(renderTimer); renderTimer = null; }
  }
  $editor.addEventListener('input', () => {
    setDirty($editor.value !== state.savedContent);
    scheduleRender();
  });

  // ------------------------------------------------------------------
  // Dirty / title
  // ------------------------------------------------------------------
  function setDirty(dirty) {
    state.isDirty = dirty;
    $dirtyDot.hidden = !dirty;
    $saveBtn.disabled = !dirty && !!state.path;
    updateTitle();
  }

  function parentDir(path) {
    // Find the last separator and keep everything before it.
    // Edge cases: drive root ("C:\file.md" → "C:\"), filesystem root ("/file.md" → "/").
    const idx = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'));
    if (idx < 0) return path;
    if (idx === 0) return path.slice(0, 1);                  // POSIX root
    if (idx === 2 && /^[A-Za-z]:[\\\/]/.test(path)) return path.slice(0, 3); // Win drive root
    return path.slice(0, idx);
  }

  function updateTitle() {
    if ($title.dataset.flashing === '1') return;             // Don't clobber the flash message.
    const display = state.path || 'untitled.md';
    const tabName = state.path ? state.path.split(/[\\/]/).pop() : 'untitled.md';
    $title.textContent = display + (state.isDirty ? ' •' : '');
    $title.title = state.path
      ? `${state.path}\n\nClick to copy folder path:\n${parentDir(state.path)}`
      : '';
    document.title = (state.isDirty ? '• ' : '') + tabName;
    // The native window title does not follow document.title in a WebView; push it.
    host.setWindowTitle(`${document.title} — TCB, M.D.`).catch(() => {/* cosmetic */});
  }

  let flashTimer = null;
  function flashTitle(message) {
    $title.dataset.flashing = '1';
    $title.textContent = message;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => {
      delete $title.dataset.flashing;
      updateTitle();
    }, 1400);
  }
  function flashCopied(folder) {
    flashTitle(`Copied: ${folder}`);
  }

  // ------------------------------------------------------------------
  // Zoom (Ctrl+= / Ctrl+- / Ctrl+0 / Ctrl+wheel), persisted across launches.
  // Owned here rather than by the WebView's built-in hotkeys so the level can be
  // stored and restored; the native hotkeys are turned off in tauri.conf.json.
  // ------------------------------------------------------------------
  const ZOOM_KEY = 'mdview.zoom';
  const ZOOM_LEVELS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];
  let zoomLevel = readStoredZoom();

  function readStoredZoom() {
    try {
      const z = parseFloat(localStorage.getItem(ZOOM_KEY));
      if (Number.isFinite(z) && z >= ZOOM_LEVELS[0] && z <= ZOOM_LEVELS[ZOOM_LEVELS.length - 1]) return z;
    } catch (_) {/* ignore */}
    return 1;
  }

  async function applyZoom(factor, { announce = true } = {}) {
    zoomLevel = factor;
    try { localStorage.setItem(ZOOM_KEY, String(factor)); } catch (_) {/* ignore */}
    try {
      await host.setZoom(factor);
    } catch (err) {
      console.warn('[zoom] failed:', err);
    }
    if (announce) flashTitle(`Zoom ${Math.round(factor * 100)}%`);
  }

  function stepZoom(direction) {
    // Snap to the nearest preset, then move one step.
    let idx = 0;
    let best = Infinity;
    ZOOM_LEVELS.forEach((z, i) => {
      const d = Math.abs(z - zoomLevel);
      if (d < best) { best = d; idx = i; }
    });
    const next = ZOOM_LEVELS[Math.min(ZOOM_LEVELS.length - 1, Math.max(0, idx + direction))];
    if (next !== zoomLevel) applyZoom(next);
  }

  // Precision touchpads / pinch deliver many small deltas per gesture; accumulate
  // and step once per ~50 units so one pinch is one zoom step, not five.
  let wheelAccum = 0;
  document.addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    wheelAccum += e.deltaY;
    if (Math.abs(wheelAccum) >= 50) {
      stepZoom(wheelAccum < 0 ? 1 : -1);
      wheelAccum = 0;
    }
  }, { passive: false });

  async function copyParentToClipboard() {
    if (!state.path) return;
    const folder = parentDir(state.path);
    try {
      await host.copyText(folder);
      flashCopied(folder);
    } catch (err) {
      console.error('[clipboard] failed:', err);
    }
  }

  $title.addEventListener('click', copyParentToClipboard);
  $title.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      copyParentToClipboard();
    }
  });

  // ------------------------------------------------------------------
  // Save button + keyboard shortcuts
  // ------------------------------------------------------------------
  $saveBtn.addEventListener('click', () => save());
  document.getElementById('openBtn')?.addEventListener('click', openFileViaDialog);

  // Keyboard shortcut map (keep the README "Keyboard shortcuts" table in sync):
  //   Ctrl+S → Save            Ctrl+Shift+S → Save As (always prompts)
  //   Ctrl+O → Open…           Ctrl+E       → toggle edit/view
  //   Ctrl+H → Versions bar    Ctrl+P       → Print     Ctrl+Shift+P → Print View
  //   Ctrl+= / Ctrl+- / Ctrl+0 → zoom in / out / reset (persisted)
  document.addEventListener('keydown', (e) => {
    const ctrl = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    // AltGr reports ctrlKey on Windows; exclude it so AltGr-typed =/+/-/0 still insert text.
    if (ctrl && !e.altKey && (e.key === '=' || e.key === '+')) {
      e.preventDefault();
      stepZoom(1);
    } else if (ctrl && !e.altKey && (e.key === '-' || e.key === '_')) {
      e.preventDefault();
      stepZoom(-1);
    } else if (ctrl && !e.altKey && !e.shiftKey && e.key === '0') {
      e.preventDefault();
      applyZoom(1);
    } else if (ctrl && !e.shiftKey && key === 's') {
      e.preventDefault();
      save();
    } else if (ctrl && e.shiftKey && key === 's') {
      e.preventDefault();
      save({ forcePrompt: true });
    } else if (ctrl && !e.shiftKey && key === 'o') {
      e.preventDefault();
      openFileViaDialog();
    } else if (ctrl && !e.shiftKey && key === 'e') {
      e.preventDefault();
      toggleEditMode();
    } else if (ctrl && !e.shiftKey && key === 'h') {
      e.preventDefault();
      toggleVersionBar();
    } else if (ctrl && !e.shiftKey && key === 'p') {
      e.preventDefault();
      window.print();
    } else if (ctrl && e.shiftKey && key === 'p') {
      e.preventDefault();
      togglePrintView();
    }
  });

  // ------------------------------------------------------------------
  // Version bar (single-row history UI)
  //
  // Flow:
  //   • Toggle 🕒 button → opens the version bar; loads version list for current file.
  //   • Dropdown is sorted current → newest history → oldest.
  //   • Selecting "Current (live)"  → preview pane shows live rendered markdown.
  //   • Selecting any past version  → diff (older vs editor content) shown in preview.
  //   • "Restore selected" loads the version into the editor (marked dirty).
  //     If "Backup current first" is on, the editor's CURRENT content is snapshotted
  //     before being overwritten — recoverable via the same dropdown afterwards.
  // ------------------------------------------------------------------
  let versionsCache = [];          // [{id, label, author, timestamp_unix}, ...]
  let versionContentCache = {};    // { id: content } — populated lazily on selection

  $versionBarToggle.addEventListener('click', toggleVersionBar);
  $versionPicker.addEventListener('change', onPickerChange);
  $restoreSelectedBtn.addEventListener('click', restoreSelected);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$versionBar.hidden) closeVersionBar();
  });

  async function toggleVersionBar() {
    if (!$versionBar.hidden) closeVersionBar();
    else await openVersionBar();
  }

  async function openVersionBar() {
    $versionBar.hidden = false;
    $versionBarToggle.setAttribute('aria-pressed', 'true');
    if (!state.path) {
      $versionPicker.innerHTML = '<option value="__current__">No file open</option>';
      $versionPicker.disabled = true;
      $versionMeta.textContent = '';
      $restoreSelectedBtn.disabled = true;
      return;
    }
    $versionPicker.innerHTML = '<option value="__current__">Current (live)</option><option disabled>Loading…</option>';
    $versionPicker.disabled = true;
    try {
      const versions = await host.listVersions(state.path);
      versionsCache = versions || [];
      versionContentCache = {};
      populatePicker(versionsCache);
    } catch (err) {
      console.error('[versions] load failed:', err);
      $versionPicker.innerHTML = '<option value="__current__">Current (live)</option><option disabled>Load failed</option>';
      $versionPicker.disabled = true;
    }
  }

  function closeVersionBar() {
    $versionBar.hidden = true;
    $versionBarToggle.setAttribute('aria-pressed', 'false');
    // If a past version was selected (diff in preview), restore live rendering.
    if ($versionPicker.value !== '__current__') {
      $versionPicker.value = '__current__';
      $versionMeta.textContent = '';
      $restoreSelectedBtn.disabled = true;
      $toggle.disabled = false;
      renderPreview($editor.value);
    }
  }

  function escapeHtmlText(s) {
    return String(s).replace(/[&<>"']/g, (c) => (
      { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#x27;' }[c]
    ));
  }

  function populatePicker(versions) {
    const opts = ['<option value="__current__">Current (live)</option>'];
    if (!versions || versions.length === 0) {
      opts.push('<option disabled>(no past versions)</option>');
    } else {
      // versions are already newest-first from Rust (git log / sorted snapshots).
      for (const v of versions) {
        const date = new Date(v.timestamp_unix * 1000).toLocaleString();
        const labelRaw = v.label || '(no message)';
        const label = labelRaw.length > 60 ? labelRaw.slice(0, 57) + '…' : labelRaw;
        const author = v.author ? ` — ${v.author}` : '';
        opts.push(
          `<option value="${escapeHtmlText(v.id)}">${escapeHtmlText(date)} · ${escapeHtmlText(label)}${escapeHtmlText(author)}</option>`
        );
      }
    }
    $versionPicker.innerHTML = opts.join('');
    $versionPicker.disabled = false;
    $versionPicker.value = '__current__';
    $versionMeta.textContent = '';
    $restoreSelectedBtn.disabled = true;
  }

  async function onPickerChange() {
    const id = $versionPicker.value;
    if (id === '__current__') {
      $versionMeta.textContent = '';
      $restoreSelectedBtn.disabled = true;
      $toggle.disabled = false;
      renderPreview($editor.value);
      return;
    }
    try {
      let content = versionContentCache[id];
      if (content === undefined) {
        content = await host.readVersion(state.path, id);
        versionContentCache[id] = content;
      }
      const diffStr = await host.diffText(content, $editor.value);
      // The diff owns the preview now: drop any pending/in-flight live render.
      cancelScheduledRender();
      renderSeq++;
      $preview.innerHTML = renderDiff(diffStr);
      const v = versionsCache.find((x) => x.id === id);
      if (v) {
        $versionMeta.textContent = `${v.id.slice(0, 7)} · ${v.author || 'snapshot'}`;
      }
      // While a past version is selected the editor is hidden + edit mode disabled.
      $body.classList.remove('mode-edit');
      $body.classList.add('mode-view');
      $editor.hidden = true;
      $toggle.checked = false;
      $toggle.disabled = true;
      $restoreSelectedBtn.disabled = false;
    } catch (err) {
      console.error('[picker] failed:', err);
      alert('Could not load that version: ' + (err?.message || err));
    }
  }

  function renderDiff(text) {
    if (!text || !text.trim()) {
      return '<pre class="diff-view"><span class="ctx">(no differences)</span></pre>';
    }
    const lines = text.split('\n').map((line) => {
      const cls =
        line.startsWith('+++') || line.startsWith('---') ? 'head' :
        line.startsWith('@@')                            ? 'hunk' :
        line.startsWith('+')                             ? 'add'  :
        line.startsWith('-')                             ? 'del'  : 'ctx';
      return `<span class="${cls}">${escapeHtmlText(line)}</span>`;
    });
    return `<pre class="diff-view">${lines.join('')}</pre>`;
  }

  async function restoreSelected() {
    const id = $versionPicker.value;
    if (id === '__current__') return;
    const content = versionContentCache[id];
    if (content === undefined) return;

    // If the user has unsaved edits AND chose not to back up, confirm — otherwise
    // those edits silently vanish.
    if (state.isDirty && !$backupFirst.checked) {
      const proceed = await host.confirm(
        'You have unsaved changes that will be discarded. Continue without backup?',
        { title: 'Restore version', kind: 'warning' },
      );
      if (!proceed) return;
    }

    // Snapshot the editor's current content into history before overwriting it.
    if ($backupFirst.checked && state.path) {
      try {
        await host.snapshotCurrent(state.path, $editor.value);
      } catch (err) {
        console.error('[backup] failed:', err);
        const proceed = await host.confirm(
          `Backup failed: ${err?.message || err}\n\nRestore anyway?`,
          { title: 'Backup failed', kind: 'warning' },
        );
        if (!proceed) return;
      }
    }

    $editor.value = content;
    setDirty(content !== state.savedContent);
    $versionPicker.value = '__current__';
    $versionMeta.textContent = '';
    $restoreSelectedBtn.disabled = true;
    $toggle.disabled = false;
    renderPreview(content);
    refreshVersionInfo();   // snapshot count may have grown if we backed up.
  }

  // ------------------------------------------------------------------
  // Print View (paged.js) + native Print
  //
  // Three pieces work together:
  //   • Ctrl+P / Print button → window.print() — OS native print preview/dialog.
  //   • Ctrl+Shift+P / 📄 button → in-window paginated preview via paged.js.
  //   • `<!-- pagebreak -->` in source → hr.mdview-pagebreak, which both
  //     paged.js and native print honour as a forced break.
  // paged.js is lazy-loaded so the ~500 KB script only downloads if you actually
  // use Print View.
  // ------------------------------------------------------------------
  $printViewToggle.addEventListener('click', togglePrintView);
  $printViewClose.addEventListener('click', exitPrintView);
  $printNowBtn.addEventListener('click', () => window.print());
  $printSize.addEventListener('change', onPrintSizeChange);
  $typesetToggle.addEventListener('change', onTypesetToggle);
  $exportPdfBtn.addEventListener('click', exportTypesetPdf);

  // ------------------------------------------------------------------
  // About dialog (app name/version + Buy Me A Coffee QR, click-to-zoom).
  // ------------------------------------------------------------------
  $aboutToggle.addEventListener('click', openAbout);
  $aboutClose.addEventListener('click', closeAbout);
  $aboutOverlay.addEventListener('click', (e) => { if (e.target === $aboutOverlay) closeAbout(); });
  $bmacQr.addEventListener('click', () => $bmacQr.classList.toggle('zoomed'));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$aboutOverlay.hidden) closeAbout();
  });

  async function openAbout() {
    $aboutOverlay.hidden = false;
    try {
      const v = await window.__TAURI__?.app?.getVersion?.();
      if (v) { $aboutVersion.textContent = 'v' + v; $aboutVersion.hidden = false; }
    } catch (_) { /* version line is optional */ }
  }
  function closeAbout() {
    $aboutOverlay.hidden = true;
    $bmacQr.classList.remove('zoomed');
  }

  // Restore typeset preference and detect external tools on startup.
  const TYPESET_KEY = 'mdview.typeset';
  if (localStorage.getItem(TYPESET_KEY) === 'true') {
    $typesetToggle.checked = true;
    $body.classList.add('typeset');
  }
  detectTypesetTools();

  function onTypesetToggle() {
    const on = $typesetToggle.checked;
    $body.classList.toggle('typeset', on);
    try { localStorage.setItem(TYPESET_KEY, String(on)); } catch (_) {/* ignore */}
    if ($body.classList.contains('mode-print-view')) {
      enterPrintView();   // re-paginate so paged.js picks up the new typography
    }
  }

  async function detectTypesetTools() {
    try {
      const tools = await host.detectTypesettingTools();
      const ok = tools && tools.pandoc && tools.typst;
      $exportPdfBtn.hidden = !ok;
      if (!ok) {
        const missing = [];
        if (!tools.pandoc) missing.push('pandoc');
        if (!tools.typst)  missing.push('typst');
        $exportPdfBtn.title = `Install ${missing.join(' + ')} on PATH to enable typeset PDF export`;
      }
    } catch (err) {
      console.warn('[typeset-tools] detection failed:', err);
    }
  }

  async function exportTypesetPdf() {
    if (!state.path) {
      alert('Open or save a file first.');
      return;
    }
    if (state.isDirty) {
      const proceed = await host.confirm(
        'You have unsaved edits. The exported PDF will use the last-saved file content. Continue?',
        { title: 'Export typeset PDF', kind: 'warning' },
      );
      if (!proceed) return;
    }
    const fname = state.path.split(/[\\/]/).pop().replace(/\.(md|markdown)$/i, '') + '.pdf';
    const defaultPath = state.path.replace(/[^\\/]+$/, fname);
    try {
      const outPath = await host.pickSavePdfPath(defaultPath);
      if (!outPath) return;
      $printViewStatus.textContent = 'Exporting via pandoc → typst…';
      await host.exportTypesetPdf(state.path, outPath);
      $printViewStatus.textContent = `Exported: ${outPath}`;
    } catch (err) {
      console.error('[export-pdf] failed:', err);
      $printViewStatus.textContent = 'Export failed';
      alert('PDF export failed:\n\n' + (err?.message || err));
    }
  }

  async function togglePrintView() {
    if ($body.classList.contains('mode-print-view')) exitPrintView();
    else await enterPrintView();
  }

  async function enterPrintView() {
    $body.classList.add('mode-print-view');
    $printViewToggle.setAttribute('aria-pressed', 'true');
    $printPages.innerHTML = '';
    $printViewStatus.textContent = 'Loading paged.js…';
    try {
      await ensurePagedJs();
      $printViewStatus.textContent = 'Paginating…';
      const sourceHtml = $preview.innerHTML;
      const wrapped = `<article class="markdown-body">${sourceHtml}</article>`;
      const previewer = new window.PagedModule.Previewer();
      const flow = await previewer.preview(wrapped, ['app.css'], $printPages);
      const n = flow && flow.total;
      $printViewStatus.textContent = n ? `${n} page${n === 1 ? '' : 's'}` : '';
    } catch (err) {
      console.error('[print-view] failed:', err);
      $printViewStatus.textContent = 'Failed: ' + describeError(err);
    }
  }

  /** Coerce arbitrary thrown values into a readable string. */
  function describeError(err) {
    if (!err) return 'unknown error';
    if (err.message) return err.message;
    if (err.target instanceof XMLHttpRequest) {
      const t = err.target;
      return `XHR ${err.type}: ${t.responseURL || '(no URL)'} status=${t.status}`;
    }
    if (err.target && err.target.src) return `failed to load ${err.target.src}`;
    if (err.type) return `${err.type} event (no message)`;
    try { return JSON.stringify(err); } catch (_) { return String(err); }
  }

  function exitPrintView() {
    $body.classList.remove('mode-print-view');
    $printViewToggle.setAttribute('aria-pressed', 'false');
    // Drop the rendered pages so a re-enter starts fresh and we don't hold ~MB of DOM.
    $printPages.innerHTML = '';
  }

  function onPrintSizeChange() {
    const styleEl = document.getElementById('printPageStyle');
    if (styleEl) styleEl.textContent = `@page { size: ${$printSize.value}; margin: 1in; }`;
    if ($body.classList.contains('mode-print-view')) {
      enterPrintView();   // re-paginate with new page size
    }
  }

  function ensurePagedJs() {
    if (window.PagedModule) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'vendor/paged.min.js';
      script.onload = () => resolve();
      script.onerror = () => reject(new Error('failed to load paged.min.js'));
      document.head.appendChild(script);
    });
  }

  // ------------------------------------------------------------------
  // Status bar toggle (visibility persisted in localStorage)
  // ------------------------------------------------------------------
  const STATUSBAR_KEY = 'mdview.showStatusbar';
  const initialShow = localStorage.getItem(STATUSBAR_KEY) !== 'false';
  applyStatusbar(initialShow);

  $statusbarBtn.addEventListener('click', () => {
    applyStatusbar(!$body.classList.contains('show-statusbar'));
  });

  function applyStatusbar(show) {
    $body.classList.toggle('show-statusbar', show);
    $statusbarBtn.setAttribute('aria-pressed', String(show));
    $statusbarBtn.textContent = show ? '▾' : '▴';
    $statusbarBtn.title = show ? 'Hide status bar' : 'Show status bar';
    try { localStorage.setItem(STATUSBAR_KEY, String(show)); } catch (_) {/* ignore */}
  }

  // ------------------------------------------------------------------
  // Initial render: show welcome until host hands us a file.
  // ------------------------------------------------------------------
  setDirty(false);   // sync Save button (enabled: no path → Save acts as Save As) + titles
  if (zoomLevel !== 1) applyZoom(zoomLevel, { announce: false });   // restore last zoom before first paint
  renderPreview('# Welcome\n\nOpen a `.md` file from File Explorer, press `Ctrl+O`, drop one onto this window, or toggle **Edit** to start writing.');

  // Kick the host. Tauri host will call onOpen if launched with a file,
  // then call frontend_ready so the window appears.
  host.init({
    onOpen: applyLoadedFile,
    onOpenPath: openPathGuarded,
    onOpenError: reportOpenError,
    onCloseRequested,
  }).catch((err) => {
    console.error('[host:init] failed:', err);
  });
})();
