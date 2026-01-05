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

// Settings (add these to package.json contributes.configuration)
// vkbd.visibleLayouts: string[]           // list of layout IDs shown in dropdown
// vkbd.layoutFiles: Record<string,string> // id -> path to JSON file
//
// Defaults:
// visibleLayouts = ["sr-latin","sr-cyrillic"]
// layoutFiles = {}

class VirtualKeyboardPanel {
  public static currentPanel: VirtualKeyboardPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];

  // When focus moves into the webview, vscode.window.activeTextEditor becomes undefined.
  // Keep the last known text editor so we can still type into it.
  private lastTextEditor: vscode.TextEditor | undefined;

  // Case state (upper/lower)
  private isUpperCase = true;

  // Layouts
  private currentLayoutId: string = SR_LATIN.id;
  private layouts: Map<string, LayoutInfo> = new Map();

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
      // If layout isn't loaded yet (e.g. settings changed), reload.
      if (!this.layouts.has(this.currentLayoutId)) {
        await this.reloadLayouts(context);
      }
      await this.pushCurrentLayoutToWebview();
      return;
    }

    if (msg.type === "toggleCase") {
      this.isUpperCase = !this.isUpperCase;
      await this.panel.webview.postMessage({ type: "caseData", upper: this.isUpperCase });
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
      case "insert":
        return this.insertText(editor, msg.text);
      case "space":
        return this.insertText(editor, " ");
      case "tab":
        return this.insertText(editor, "\t");
      case "enter":
        return this.insertText(editor, "\n");
      case "backspace":
        return this.backspace(editor);
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

    // Always make built-ins available if requested
    for (const id of visible) {
      if (BUILTIN_LAYOUTS[id]) {
        next.set(id, BUILTIN_LAYOUTS[id]);
      }
    }

    // Load file-backed layouts (only those that are visible)
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

    // Ensure we have at least one layout
    if (next.size === 0) {
      next.set(SR_LATIN.id, SR_LATIN);
    }

    this.layouts = next;

    // Ensure current layout exists
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
    // absolute path => use as-is
    if (filePath.startsWith("/") || /^[A-Za-z]:\\/.test(filePath)) {
      return vscode.Uri.file(filePath);
    }

    // If there is a workspace, resolve relative to the first workspace folder
    const ws = vscode.workspace.workspaceFolders?.[0];
    if (ws) {
      return vscode.Uri.joinPath(ws.uri, filePath);
    }

    // Fallback: resolve relative to extension root
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
      upper: this.isUpperCase,
    });

    // also ensure dropdown selection is synced
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

    /* Dropdown styled with VS Code input colors */
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

    /* Make case button show a "pressed" feel */
    .pressed {
      background: var(--vscode-button-background) !important;
      color: var(--vscode-button-foreground) !important;
    }
  </style>
</head>
<body>
  <div class="top">
    <p class="hint">Click symbols to type into the active editor.</p>
    <label>
      <select id="layout-select" title="Layout"></select>
    </label>
  </div>

  <div id="grid" class="grid" style="grid-template-columns: repeat(10, minmax(0, 1fr));"></div>

  <div class="row">
    <button class="key" id="btn-case" title="Toggle case">⇧</button>
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

    let state = { layout: 'sr-latin', symbols: [], columns: 10, upper: true };
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

    function renderGrid() {
      gridEl.style.gridTemplateColumns = 'repeat(' + state.columns + ', minmax(0, 1fr))';
      gridEl.innerHTML = '';

      for (const sym of state.symbols) {
        const b = document.createElement('button');
        b.className = 'key';
        const text = state.upper ? sym : sym.toLocaleLowerCase();
        b.textContent = text;
        b.onclick = () => post({ type: 'insert', text });
        gridEl.appendChild(b);
      }

      btnCase.classList.toggle('pressed', state.upper);
    }

    function render() {
      renderSelect();
      renderGrid();
    }

    layoutSelect.onchange = () => {
      const id = layoutSelect.value;
      post({ type: 'setLayout', layout: id });
    };

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
        // keep current selection
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
        render();
      }

      if (msg?.type === 'caseData') {
        state.upper = msg.upper;
        renderGrid();
      }
    });

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

/*
package.json additions (example):

{
  "activationEvents": ["onCommand:vkbd.open"],
  "contributes": {
    "commands": [{ "command": "vkbd.open", "title": "Virtual Keyboard: Open" }],
    "keybindings": [{ "command": "vkbd.open", "key": "ctrl+alt+k", "when": "editorTextFocus" }],
    "configuration": {
      "title": "Virtual Keyboard",
      "properties": {
        "vkbd.visibleLayouts": {
          "type": "array",
          "default": ["sr-latin", "sr-cyrillic"],
          "description": "Layout IDs visible in the keyboard dropdown.",
          "items": { "type": "string" }
        },
        "vkbd.layoutFiles": {
          "type": "object",
          "default": {},
          "description": "Mapping from layout ID to JSON file path (absolute or relative to workspace/extension).",
          "additionalProperties": { "type": "string" }
        }
      }
    }
  }
}

Layout JSON format:
{
  "id": "custom",
  "name": "My Custom",
  "columns": 12,
  "symbols": ["A","B","C"]
}
*/
