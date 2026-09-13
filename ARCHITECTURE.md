# API Database Schema Tools v0.7 architecture

## Boundary

The plugin owns:

1. `[[@` hierarchical schema reference picker.
2. Schema Studio browse/edit/import UI.
3. JSON and dialect-aware DDL import + inline cell diff.
4. A low-frequency Command Palette onboarding flow that installs a self-contained demo and temporarily switches plugin paths.

Persistent data remains Markdown + YAML frontmatter + Wikilinks. Fileclass remains the business-property schema source.

## Demo onboarding contract

The demo installer is intentionally not a Ribbon action. It is exposed only through Ctrl/Cmd+P commands:

- `安装 / 打开体验样例`
- `退出体验样例并恢复插件配置`

The installer creates exactly one top-level Vault entry:

```text
_SchemaTools-Demo/
```

All demo API docs, DB docs, field notes, Bases, Fileclass definitions, JSON samples, DDL samples, and design docs live below that root.

Before writing anything, the confirmation modal lists every plugin setting that will change. Schema Tools settings are backed up. If Fileclass is installed, its `classFilesPath` is also backed up before being temporarily pointed at the demo class folder. Existing Vault files are never moved or overwritten.

Restoring demo mode restores the backed-up settings but deliberately leaves `_SchemaTools-Demo/` in place to avoid deleting user edits made during evaluation.

If `_SchemaTools-Demo/` already exists, the installer never overwrites it. The user may open it as-is or switch current plugin paths back to the existing demo.

## Grid view state

Browse grids have view state per domain (`api` / `db`): hidden properties, multi-column sort rules, AND filter rules, and transient search text.

## Pending edit model

Manual edits are stored separately from frontmatter until Save:

```text
persisted frontmatter + pending edits -> current grid value
```

If current value differs from persisted value, the same inline diff renderer used by import review shows `~~old~~ -> new`.

## Spreadsheet keyboard contract

- Double click: enter editor; no select-all; caret placed near pointer X.
- Enter in editor: commit current cell directly.
- Escape in editor: cancel current cell and keep Schema Studio open.
- Arrow keys outside editor: move focused cell.
- Ctrl/Cmd + arrows: scroll grid viewport without moving focus.
- Boolean: double-click / Enter / Space toggles directly.
- Rectangular selection: TSV copy/paste compatible with Excel/WPS.

## Fileclass-driven properties

Schema Studio discovers dynamic properties from Fileclass definitions. Importers only own the minimal structural contract inferred from JSON/DDL. Business fields remain preserved on re-import.

## DDL adapter contract

```text
id
label
description
parse(sql) -> [{ table, columns[] }]
```

Current adapters: MySQL, Oracle.


## v0.7.1 中文体验样例

体验目录仍集中在 `_SchemaTools-Demo/`；用户可读样例内容中文化，技术字段名、数据库标识和 Request/Response 内部值保持稳定。
