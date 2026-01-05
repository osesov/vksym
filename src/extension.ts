// src/extension.ts
import * as vscode from "vscode";

type LayoutId = string;

type KeyMsg =
  | { type: "insert"; text: string }
  | { type: "backspace" }
  | { type: "enter" }
  | { type: "tab" }
  | { type: "space" }
  | { type: "toggleCase" }
  | { type: "shiftDown" }
  | { type: "shiftUp" }
  | { type: "setLayout"; layout: LayoutId };

type LayoutJson = {
  id?: string;
  name?: string;
  columns?: number;
  symbols: string[];
};

type LayoutInfo = {
  id: string;
  name: string;
  columns: number;
  symbols: string[];
};

// Built-in layouts
const SR_LATIN: LayoutInfo = {
  id: "sr-latin",
  name: "SR Latin",
  columns: 10,
  symbols: [
    "A", "B", "C", "Č", "Ć", "D", "Dž", "Đ", "E", "F",
    "G", "H", "I", "J", "K", "L", "Lj", "M", "N", "Nj",
    "O", "P", "R", "S", "Š", "T", "U", "V", "Z", "Ž",
  ],
};

const SR_CYRILLIC: LayoutInfo = {
  id: "sr-cyrillic",
  name: "SR Cyr",
  columns: 10,
  symbols: [
    "А", "Б", "В", "Г", "Д", "Ђ", "Е", "Ж", "З", "И",
    "Ј", "К", "Л", "Љ", "М", "Н", "Њ", "О", "П", "Р",
    "С", "Т", "Ћ", "У", "Ф", "Х", "Ц", "Ч", "Џ", "Ш",
  ],
};

const BUILTIN_LAYOUTS: Record<string, LayoutInfo> = {
  [SR_LATIN.id]: SR_LATIN,
  [SR_CYRILLIC.id]: SR_CYRILLIC,
};

class VirtualKeyboardPanel {
  public static currentPanel: VirtualKeyboardPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];

  // When focus moves into the webview, vscode.window.activeTextEditor can become undefined.
  // Keep the last known text editor so we can still type into it.
  private lastTextEditor: vscode.TextEditor | undefined;

  // Keyboard state:
  // - capsLock: sticky (virtual "caps") toggled by ⇧ button
  // - shiftHeld: momentary shift tracked when webview gets keydown/keyup
  private capsLock = false;
  private shiftHeld = false;

  // Layouts
  private currentLayoutId: string = SR_LATIN.id;
  private layouts: Map<string, LayoutInfo> = new Map();

  private get effectiveUpper(): boolean {
    // Typical behavior: CapsLock XOR Shift
    return this.capsLock !== this.shiftHeld;
  }

  static open(context: vscode.ExtensionContext) {
    const column = vscode.ViewColumn.Beside;

    if (VirtualKeyboardPanel.currentPanel) {
      VirtualKeyboardPanel.currentPanel.panel.reveal(column);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      "virtualKeyboard",
      "Virtual Keyboard",
      { viewColumn: column, preserveFocus: true },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      }
    );

    VirtualKeyboardPanel.currentPanel = new VirtualKeyboardPanel(panel, context);
  }

  private constructor(panel: vscode.WebviewPanel, context: vscode.ExtensionContext) {
    this.panel = panel;
    this.panel.webview.html = this.getHtml(this.panel.webview);

    // Capture the editor that was active when the panel was opened.
    this.lastTextEditor = vscode.window.activeTextEditor;

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    // Track the last active text editor (so clicks inside webview won't break typing).
    context.subscriptions.push(
      vscode.window.onDidChangeActiveTextEditor((ed) => {
        if (ed) this.lastTextEditor = ed;
      })
    );

    // Reload layouts on settings change
    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration(async (e) => {
        if (e.affectsConfiguration("vkbd.visibleLayouts") || e.affectsConfiguration("vkbd.layoutFiles")) {
          await this.reloadLayouts(context);
          await this.pushLayoutsToWebview();
          await this.pushCurrentLayoutToWebview();
        }
      })
    );

    this.panel.webview.onDidReceiveMessage(
      async (msg: KeyMsg) => {
        try {
          await this.handleMessage(msg, context);
        } catch (e) {
          console.error(e);
          vscode.window.showErrorMessage(`Virtual Keyboard error: ${String(e)}`);
        }
      },
      null,
      this.disposables
    );

    // Initial load
    void (async () => {
      await this.reloadLayouts(context);
      await this.pushLayoutsToWebview();
      await this.pushCurrentLayoutToWebview();
    })();
  }

  private dispose() {
    VirtualKeyboardPanel.currentPanel = undefined;
    while (this.disposables.length) this.disposables.pop()?.dispose();
  }

  private getTargetEditor(): vscode.TextEditor | undefined {
    return vscode.window.activeTextEditor ?? this.lastTextEditor;
  }

  private async ensureEditorIsActive(editor: vscode.TextEditor): Promise<vscode.TextEditor> {
    try {
      const viewColumn = editor.viewColumn ?? vscode.ViewColumn.Active;
      return await vscode.window.showTextDocument(editor.document, {
        viewColumn,
        preserveFocus: true,
        preview: false,
        selection: editor.selection,
      });
    } catch {
      return editor;
    }
  }

  private async handleMessage(msg: KeyMsg, context: vscode.ExtensionContext) {
    if (msg.type === "setLayout") {
      this.currentLayoutId = msg.layout;
      if (!this.layouts.has(this.currentLayoutId)) {
        await this.reloadLayouts(context);
      }
      await this.pushCurrentLayoutToWebview();
      return;
    }

    if (msg.type === "toggleCase") {
      this.capsLock = !this.capsLock;
      await this.panel.webview.postMessage({ type: "caseData", upper: this.effectiveUpper, caps: this.capsLock, shift: this.shiftHeld });
      return;
    }

    if (msg.type === "shiftDown") {
      if (!this.shiftHeld) {
        this.shiftHeld = true;
        await this.panel.webview.postMessage({ type: "caseData", upper: this.effectiveUpper, caps: this.capsLock, shift: this.shiftHeld });
      }
      return;
    }

    if (msg.type === "shiftUp") {
      if (this.shiftHeld) {
        this.shiftHeld = false;
        await this.panel.webview.postMessage({ type: "caseData", upper: this.effectiveUpper, caps: this.capsLock, shift: this.shiftHeld });
      }
      return;
    }

    const target = this.getTargetEditor();
    if (!target) {
      vscode.window.showInformationMessage("No active editor to type into.");
      return;
    }

    const editor = await this.ensureEditorIsActive(target);
    this.lastTextEditor = editor;

    switch (msg.type) {
      case "insert": {
        await this.insertText(editor, msg.text);
        await this.returnFocus(editor);
        return;
      }
      case "space": {
        await this.insertText(editor, " ");
        await this.returnFocus(editor);
        return;
      }
      case "tab": {
        await this.insertText(editor, "\t");
        await this.returnFocus(editor);
        return;
      }
      case "enter": {
        await this.insertText(editor, "\n");
        await this.returnFocus(editor);
        return;
      }
      case "backspace": {
        await this.backspace(editor);
        await this.returnFocus(editor);
        return;
      }
    }
  }

  private async insertText(editor: vscode.TextEditor, text: string) {
    await editor.edit(
      (edit) => {
        for (const sel of editor.selections) {
          if (!sel.isEmpty) edit.replace(sel, text);
          else edit.insert(sel.active, text);
        }
      },
      { undoStopBefore: true, undoStopAfter: true }
    );
  }

  private async returnFocus(editor: vscode.TextEditor) {
    try {
      const viewColumn = editor.viewColumn ?? vscode.ViewColumn.Active;
      await vscode.window.showTextDocument(editor.document, {
        viewColumn,
        preserveFocus: false,
        preview: false,
        selection: editor.selection,
      });
    } catch {
      // ignore
    }
  }

  private async backspace(editor: vscode.TextEditor) {
    const doc = editor.document;

    await editor.edit(
      (edit) => {
        for (const sel of editor.selections) {
          if (!sel.isEmpty) {
            edit.delete(sel);
            continue;
          }
          const pos = sel.active;
          if (pos.character === 0 && pos.line === 0) continue;
          const from =
            pos.character > 0
              ? pos.translate(0, -1)
              : new vscode.Position(pos.line - 1, doc.lineAt(pos.line - 1).text.length);
          edit.delete(new vscode.Range(from, pos));
        }
      },
      { undoStopBefore: true, undoStopAfter: true }
    );
  }

  private async reloadLayouts(context: vscode.ExtensionContext) {
    const cfg = vscode.workspace.getConfiguration("vkbd");
    const visible = cfg.get<string[]>("visibleLayouts") ?? [SR_LATIN.id, SR_CYRILLIC.id];
    const layoutFiles = cfg.get<Record<string, string>>("layoutFiles") ?? {};

    const next = new Map<string, LayoutInfo>();

    for (const id of visible) {
      if (BUILTIN_LAYOUTS[id]) next.set(id, BUILTIN_LAYOUTS[id]);
    }

    for (const id of visible) {
      if (next.has(id)) continue;
      const filePath = layoutFiles[id];
      if (!filePath) continue;

      try {
        const layout = await this.loadLayoutFromFile(context, id, filePath);
        next.set(id, layout);
      } catch (e) {
        console.error(e);
        vscode.window.showWarningMessage(`Virtual Keyboard: failed to load layout '${id}' from '${filePath}'.`);
      }
    }

    if (next.size === 0) next.set(SR_LATIN.id, SR_LATIN);

    this.layouts = next;

    if (!this.layouts.has(this.currentLayoutId)) {
      this.currentLayoutId = [...this.layouts.keys()][0];
    }
  }

  private async loadLayoutFromFile(
    context: vscode.ExtensionContext,
    fallbackId: string,
    filePath: string
  ): Promise<LayoutInfo> {
    const uri = this.resolveLayoutUri(context, filePath);
    const bytes = await vscode.workspace.fs.readFile(uri);
    const text = new TextDecoder("utf-8").decode(bytes);

    let json: LayoutJson;
    try {
      json = JSON.parse(text) as LayoutJson;
    } catch {
      throw new Error("Invalid JSON");
    }

    if (!json || !Array.isArray(json.symbols)) {
      throw new Error("Layout JSON must contain 'symbols: string[]'");
    }

    const id = (json.id && String(json.id)) || fallbackId;
    const name = (json.name && String(json.name)) || id;
    const columns = Number.isFinite(json.columns) ? Math.max(1, Number(json.columns)) : 10;
    const symbols = json.symbols.map(String);

    return { id, name, columns, symbols };
  }

  private resolveLayoutUri(context: vscode.ExtensionContext, filePath: string): vscode.Uri {
    if (filePath.startsWith("/") || /^[A-Za-z]:\\/.test(filePath)) {
      return vscode.Uri.file(filePath);
    }

    const ws = vscode.workspace.workspaceFolders?.[0];
    if (ws) {
      return vscode.Uri.joinPath(ws.uri, filePath);
    }

    return vscode.Uri.joinPath(context.extensionUri, filePath);
  }

  private async pushLayoutsToWebview() {
    const layouts = [...this.layouts.values()].map((l) => ({ id: l.id, name: l.name }));
    await this.panel.webview.postMessage({
      type: "layoutsList",
      layouts,
      current: this.currentLayoutId,
    });
  }

  private async pushCurrentLayoutToWebview() {
    const layout = this.layouts.get(this.currentLayoutId) ?? SR_LATIN;
    await this.panel.webview.postMessage({
      type: "layoutData",
      layout: layout.id,
      symbols: layout.symbols,
      columns: layout.columns,
      upper: this.effectiveUpper,
      caps: this.capsLock,
      shift: this.shiftHeld,
    });

    await this.panel.webview.postMessage({ type: "currentLayout", id: layout.id });
  }

  private getHtml(_webview: vscode.Webview) {
    return /* html */ `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Virtual Keyboard</title>
  <style>
    :root { --pad:10px; --gap:8px; --radius:10px; --font:14px; }

    body {
      margin:0;
      padding:var(--pad);
      font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
      user-select:none;
      background: var(--vscode-editor-background);
      color: var(--vscode-editor-foreground);
    }

    .top { display:flex; justify-content:space-between; gap:var(--gap); margin-bottom:10px; flex-wrap:wrap; align-items:center; }
    .hint { opacity:.8; font-size:12px; margin:0; }

    select {
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-widget-border);
      border-radius: 6px;
      padding: 6px 10px;
      outline: none;
    }
    select:focus-visible {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: 1px;
    }

    .grid { display:grid; gap:var(--gap); }

    .key {
      padding:10px;
      border-radius:var(--radius);
      border: 1px solid var(--vscode-widget-border);
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      cursor:pointer;
      min-width:44px;
      font-size: var(--font);
    }

    .key:hover { background: var(--vscode-button-secondaryHoverBackground); }
    .key:active { transform: translateY(1px); }
    .key:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }

    .row { display:flex; gap:var(--gap); margin-top:var(--gap); flex-wrap:wrap; }

    .pressed {
      background: var(--vscode-button-background) !important;
      color: var(--vscode-button-foreground) !important;
    }

    /* Visual distinction for momentary shift */
    .shiftHeld {
      box-shadow: 0 0 0 1px var(--vscode-focusBorder) inset;
    }
  </style>
</head>
<body>
  <div class="top">
    <p class="hint">Click symbols to type into the active editor. (Hold Shift in this panel to invert case.)</p>
    <label>
      <select id="layout-select" title="Layout"></select>
    </label>
  </div>

  <div id="grid" class="grid" style="grid-template-columns: repeat(10, minmax(0, 1fr));"></div>

  <div class="row">
    <button class="key" id="btn-case" title="Toggle caps">⇧</button>
    <button class="key" data-action="tab">Tab</button>
    <button class="key" data-action="enter">Enter</button>
    <button class="key" data-action="backspace">Backspace</button>
    <button class="key" data-action="space">Space</button>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    const gridEl = document.getElementById('grid');
    const btnCase = document.getElementById('btn-case');
    const layoutSelect = document.getElementById('layout-select');

    let state = { layout: 'sr-latin', symbols: [], columns: 10, upper: true, caps: false, shift: false };
    let layoutsList = []; // {id,name}[]

    function post(msg) { vscode.postMessage(msg); }

    function renderSelect() {
      layoutSelect.innerHTML = '';
      for (const l of layoutsList) {
        const opt = document.createElement('option');
        opt.value = l.id;
        opt.textContent = l.name;
        if (l.id === state.layout) opt.selected = true;
        layoutSelect.appendChild(opt);
      }
    }

    function computeColumns() {
      // Responsive: compute how many keys fit into current view width.
      // We treat state.columns as a *maximum* column count provided by the layout.
      const GAP = 8;           // must match --gap in CSS
      const KEY_MIN = 44;      // must match .key min-width
      const w = gridEl.clientWidth || 0;
      const fit = Math.max(1, Math.floor((w + GAP) / (KEY_MIN + GAP)));
      const maxCols = Number(state.columns) > 0 ? state.columns : fit;
      return Math.max(1, Math.min(fit, maxCols));
    }

    function applyColumns() {
      const cols = computeColumns();
      gridEl.style.gridTemplateColumns = 'repeat(' + cols + ', minmax(0, 1fr))';
    }

    function renderGrid() {
      applyColumns();
      gridEl.innerHTML = '';

      for (const sym of state.symbols) {
        const b = document.createElement('button');
        b.className = 'key';
        const text = state.upper ? sym : sym.toLocaleLowerCase();
        b.textContent = text;
        b.onclick = () => post({ type: 'insert', text });
        gridEl.appendChild(b);
      }

      // Caps is sticky; shift is momentary.
      btnCase.classList.toggle('pressed', state.caps);
      btnCase.classList.toggle('shiftHeld', state.shift);
    }

    function render() {
      renderSelect();
      renderGrid();
    }

    layoutSelect.onchange = () => {
      const id = layoutSelect.value;
      post({ type: 'setLayout', layout: id });
    };

    // Track Shift while the webview has focus
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Shift') {
        post({ type: 'shiftDown' });
      }
    });

    document.addEventListener('keyup', (e) => {
      if (e.key === 'Shift') {
        post({ type: 'shiftUp' });
      }
    });

    // Safety: if the panel loses focus while Shift is held, release it.
    window.addEventListener('blur', () => {
      if (state.shift) post({ type: 'shiftUp' });
    });

    document.onclick = (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      if (btn.id === 'btn-case') {
        post({ type: 'toggleCase' });
        return;
      }
      const a = btn.getAttribute('data-action');
      if (a) post({ type: a });
    };

    window.addEventListener('message', (e) => {
      const msg = e.data;

      if (msg?.type === 'layoutsList') {
        layoutsList = msg.layouts || [];
        if (msg.current) state.layout = msg.current;
        renderSelect();
      }

      if (msg?.type === 'currentLayout') {
        state.layout = msg.id;
        renderSelect();
      }

      if (msg?.type === 'layoutData') {
        state.layout = msg.layout;
        state.symbols = msg.symbols;
        state.columns = msg.columns ?? state.columns;
        state.upper = msg.upper ?? state.upper;
        state.caps = msg.caps ?? state.caps;
        state.shift = msg.shift ?? state.shift;
        render();
      }

      if (msg?.type === 'caseData') {
        state.upper = msg.upper ?? state.upper;
        state.caps = msg.caps ?? state.caps;
        state.shift = msg.shift ?? state.shift;
        renderGrid();
      }
    });

    // Re-apply columns when the webview is resized (split view / panel resize)
    const ro = new ResizeObserver(() => {
      // avoid rebuilding DOM; just adjust the column template
      applyColumns();
    });
    ro.observe(gridEl);

    window.addEventListener('resize', () => applyColumns());

    render();
  </script>
</body>
</html>`;
  }
}

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand("vkbd.open", () => VirtualKeyboardPanel.open(context))
  );
}

export function deactivate() {}
