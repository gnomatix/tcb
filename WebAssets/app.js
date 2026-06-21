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

  // ------------------------------------------------------------------
  // Markdown flavor support matrix.
  // Maps detected-feature label -> which flavor(s) support it.
  // `null` means the flavor has no validation (i.e. anything goes).
  // Keep these sets in sync with the detector labels in src-tauri/src/lib.rs.
  // ------------------------------------------------------------------
  const FLAVOR_SUPPORT = {
    any:           null,
    commonmark:    new Set([]),
    gfm:           new Set(['tables', 'tasklists', 'strikethrough', 'footnotes', 'github-alerts']),
    pandoc:        new Set(['tables', 'tasklists', 'strikethrough', 'footnotes', 'math',
                            'heading-attrs', 'fenced-divs', 'definitions', 'citations', 'frontmatter']),
    multimarkdown: new Set(['tables', 'footnotes', 'math', 'heading-attrs', 'definitions',
                            'citations', 'frontmatter']),
    obsidian:      new Set(['tables', 'tasklists', 'strikethrough', 'footnotes', 'github-alerts',
                            'math', 'wikilinks', 'frontmatter']),
  };
  const FLAVOR_KEY = 'mdview.flavor';
  $flavorSelect.value = localStorage.getItem(FLAVOR_KEY) || 'gfm';
  let lastFeatures = [];

  // State
  const state = {
    path: null,            // Absolute file path provided by host, or null for unsaved doc.
    savedContent: '',      // Content as-of last load or save. Used for dirty detection.
    isDirty: false,
  };

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
    return {
      kind: 'tauri',
      async init({ onOpen }) {
        await listen('open-file', async (e) => {
          const path = typeof e.payload === 'string' ? e.payload : e.payload?.path;
          if (!path) return;
          const file = await invoke('open_path', { path });
          if (file) onOpen(file);
        });
        const launch = await invoke('get_launch_file');
        if (launch) onOpen(launch);
        await invoke('frontend_ready');
      },
      async save(path, content) {
        await invoke('save_file', { path, content });
        return { path };
      },
      async saveAs(content) {
        const { save } = window.__TAURI__.dialog;
        const path = await save({
          defaultPath: 'untitled.md',
          filters: [{ name: 'Markdown', extensions: ['md', 'markdown'] }],
        });
        if (!path) return null;
        await invoke('save_file', { path, content });
        return { path };
      },
      async copyText(text) {
        await clipboard.writeText(text);
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
    return {
      kind: 'mock',
      async init() {/* no launch file */},
      async save(path, content) {
        console.info('[host:mock] would save', path, content.length, 'bytes');
        return { path };
      },
      async saveAs(content) {
        console.info('[host:mock] would saveAs', content.length, 'bytes');
        return { path: 'untitled.md' };
      },
      async copyText(text) {
        if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
        else console.info('[host:mock] would copy', text);
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
  async function applyLoadedFile({ path, content }) {
    state.path = path || null;
    state.savedContent = content || '';
    $editor.value = state.savedContent;
    setDirty(false);
    await applyFileFlavorPreference();   // adjust dropdown BEFORE render so badges use right flavor
    await renderPreview(state.savedContent);
    refreshVersionInfo();
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
        $versionInfo.textContent = parts.join(' · ');
        $versionInfo.title =
          `Backend: git\nBranch: ${info.branch}\nFile status: ${info.status}\n${info.count} commit(s) touched this file`;
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

  async function save() {
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
      const result = state.path
        ? await host.save(state.path, content)
        : await host.saveAs(content);
      if (!result) return;            // User cancelled saveAs dialog.
      state.path = result.path;
      state.savedContent = content;
      setDirty(false);
      refreshVersionInfo();           // count + status may have changed.
    } catch (err) {
      console.error('[save] failed:', err);
      alert('Save failed: ' + (err?.message || err));
    }
  }

  // ------------------------------------------------------------------
  // Render
  // ------------------------------------------------------------------
  async function renderPreview(text) {
    try {
      const { html, features } = await host.renderMarkdown(text || '');
      $preview.innerHTML = html;
      renderFeatureBadges(features);
      await renderMathIfPresent($preview);
    } catch (err) {
      console.error('[render] failed:', err);
    }
  }

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
    // TODO(you): save-on-toggle policy. ~5 lines.
    // When the user flips back to view with unsaved changes, what should happen?
    //   (a) Silently keep edits in memory (current behaviour).
    //   (b) Auto-save if state.path exists (matches Notepad's autosave-on-close).
    //   (c) Prompt to save (most explicit; interrupts flow).
    // Pick one and add it here.

    renderPreview($editor.value);
    $body.classList.remove('mode-edit');
    $body.classList.add('mode-view');
    $editor.hidden = true;
  }

  // ------------------------------------------------------------------
  // Editor change handling
  // ------------------------------------------------------------------
  // TODO(you): re-render strategy. ~10 lines.
  // Pick how aggressively to refresh the preview from editor content:
  //   (a) Eager: on every 'input' event. Simplest, but laggy on large files.
  //   (b) Debounced: re-render N ms after the last keystroke. Smoother;
  //       requires a small setTimeout/clearTimeout cycle.
  //   (c) Only on toggle-back-to-view (current behaviour). Snappiest typing,
  //       but the preview can drift from the editor until you flip back.
  $editor.addEventListener('input', () => {
    setDirty($editor.value !== state.savedContent);
    // Add re-render call here if you picked (a) or (b).
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
  }

  let flashTimer = null;
  function flashCopied(folder) {
    $title.dataset.flashing = '1';
    $title.textContent = `Copied: ${folder}`;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => {
      delete $title.dataset.flashing;
      updateTitle();
    }, 1400);
  }

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
  $saveBtn.addEventListener('click', save);

  // TODO(you): keyboard shortcut map. ~5 lines.
  // Ctrl+S → save is wired below. Pick others to bind now or defer:
  //   Ctrl+E         → toggle edit/view
  //   Ctrl+Shift+S   → Save As (force prompt)
  //   F11            → fullscreen
  document.addEventListener('keydown', (e) => {
    const ctrl = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (ctrl && !e.shiftKey && key === 's') {
      e.preventDefault();
      save();
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
  renderPreview('# Welcome\n\nOpen a `.md` file from File Explorer, or toggle **Edit** to start writing.');

  // Kick the host. Tauri host will call onOpen if launched with a file,
  // then call frontend_ready so the window appears.
  host.init({ onOpen: applyLoadedFile }).catch((err) => {
    console.error('[host:init] failed:', err);
  });
})();
