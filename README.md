# VS Code Virtual Keyboard

A **virtual keyboard** implemented as a **VS Code Webview Panel**. It renders a configurable **grid of symbols** (default: Serbian Latin and Serbian Cyrillic), supports **uppercase/lowercase toggle**, and inserts characters into the active editor even while the webview has focus.

## Features

- Webview Panel UI with clickable keys
- Symbol grid with configurable column count per layout
- Uppercase / lowercase toggle (⇧)
- Inserts into the last active editor even when the webview is focused
- Multiple cursors / selections supported
- Layout selector as a dropdown
- Loads layouts from JSON files
- Settings control which layouts are visible (defaults: `sr-latin`, `sr-cyrillic`)

## Command

- `vkbd.open` — Open / focus the Virtual Keyboard panel

## Suggested keybinding

Add to your keybindings (or contribute it from your extension):

```json
{
  "key": "ctrl+alt+k",
  "command": "vkbd.open",
  "when": "editorTextFocus"
}
```

## Configuration

Expose these settings from your extension `package.json` under `contributes.configuration`:

```json
{
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
```

### User settings example (`settings.json`)

```json
{
  "vkbd.visibleLayouts": ["sr-latin", "sr-cyrillic", "math"],
  "vkbd.layoutFiles": {
    "math": "layouts/math.json"
  }
}
```

### Path resolution

For each entry in `vkbd.layoutFiles`:

1. **Absolute paths** are used as-is.
2. If a workspace is open, **relative paths** are resolved against the **first workspace folder**.
3. Otherwise, relative paths are resolved against the **extension root**.

## Layout JSON format

A layout file is JSON with:

- `symbols` (**required**) — array of strings to show as keys
- `columns` (optional) — number of columns in the grid (default: `10`)
- `name` (optional) — display name in the dropdown
- `id` (optional) — can override the id from the settings key

Example (`layouts/math.json`):

```json
{
  "id": "math",
  "name": "Math Symbols",
  "columns": 12,
  "symbols": ["∀", "∃", "∈", "∉", "⊂", "⊆", "⊃", "⊇", "∧", "∨", "¬", "→"]
}
```

## Built-in layouts

- `sr-latin` — Serbian Latin alphabet (includes `Č Ć Š Ž Đ` and digraph letters `Lj Nj Dž`)
- `sr-cyrillic` — Serbian Cyrillic alphabet

## How it works (high level)

- The webview sends messages (e.g. `{ type: "insert", text }`, `{ type: "setLayout", layout }`).
- The extension tracks the last active editor and applies edits using `TextEditor.edit(...)`.
- Theme integration uses VS Code CSS variables (e.g. `--vscode-editor-background`, `--vscode-button-secondaryBackground`, `--vscode-input-background`) for good dark/light mode appearance.

## License

See [License file](./LICENSE.md)
