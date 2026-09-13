'use strict';
const {
  Plugin, Modal, Notice, Setting, PluginSettingTab, TFile, EditorSuggest, normalizePath, stringifyYaml, setIcon
} = require('obsidian');
const core = (() => {
function sanitizeSegment(value) {
  return String(value ?? '')
    .trim()
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/\[\]/g, '_list')
    .replace(/\.+/g, '_')
    .replace(/^_+|_+$/g, '') || 'field';
}

function inferScalarType(v) {
  if (v === null) return 'null';
  if (typeof v === 'string') return 'string';
  if (typeof v === 'boolean') return 'boolean';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

function inferArrayItemType(arr) {
  const nonNull = arr.filter((x) => x !== null && x !== undefined);
  if (!nonNull.length) return { kind: 'unknown', dataType: 'unknown' };
  const kinds = new Set(nonNull.map((x) => Array.isArray(x) ? 'array' : typeof x));
  if (kinds.size > 1) return { kind: 'mixed', dataType: 'mixed' };
  const kind = [...kinds][0];
  if (kind === 'object') return { kind: 'object', dataType: 'object' };
  if (kind === 'array') return { kind: 'array', dataType: 'array' };
  const scalarTypes = new Set(nonNull.map(inferScalarType));
  return scalarTypes.size === 1
    ? { kind: 'scalar', dataType: [...scalarTypes][0] }
    : { kind: 'mixed', dataType: [...scalarTypes].sort().join('|') };
}

function flattenJsonSample(input) {
  const rows = [];
  let order = 10;
  const push = (row) => rows.push({
    path: row.path,
    parent_path: row.parent_path || '',
    name: row.name,
    shape: row.shape,
    data_type: row.data_type,
    order: order += 10,
  });

  function walkValue(value, path, parentPath, name) {
    if (Array.isArray(value)) {
      const info = inferArrayItemType(value);
      if (info.kind === 'object') {
        push({ path, parent_path: parentPath, name, shape: 'List<Object>', data_type: 'array<object>' });
        const sample = value.find((x) => x && typeof x === 'object' && !Array.isArray(x)) || {};
        for (const [k, v] of Object.entries(sample)) {
          walkValue(v, `${path}[].${k}`, path, k);
        }
      } else if (info.kind === 'array') {
        push({ path, parent_path: parentPath, name, shape: 'List', data_type: 'array<array>' });
      } else {
        push({ path, parent_path: parentPath, name, shape: 'List', data_type: `array<${info.dataType}>` });
      }
      return;
    }
    if (value && typeof value === 'object') {
      push({ path, parent_path: parentPath, name, shape: 'Object', data_type: 'object' });
      for (const [k, v] of Object.entries(value)) {
        walkValue(v, path ? `${path}.${k}` : k, path, k);
      }
      return;
    }
    push({ path, parent_path: parentPath, name, shape: 'Scalar', data_type: inferScalarType(value) });
  }

  if (Array.isArray(input)) {
    const info = inferArrayItemType(input);
    push({ path: '$', parent_path: '', name: '$', shape: info.kind === 'object' ? 'List<Object>' : 'List', data_type: `array<${info.dataType}>` });
    if (info.kind === 'object') {
      const sample = input.find((x) => x && typeof x === 'object' && !Array.isArray(x)) || {};
      for (const [k, v] of Object.entries(sample)) walkValue(v, `[].${k}`, '$', k);
    }
  } else if (input && typeof input === 'object') {
    for (const [k, v] of Object.entries(input)) walkValue(v, k, '', k);
  } else {
    push({ path: '$', parent_path: '', name: '$', shape: 'Scalar', data_type: inferScalarType(input) });
  }
  // First actual field should start at 10.
  rows.forEach((row, i) => { row.order = (i + 1) * 10; });
  return rows;
}

function splitTopLevel(input, delimiter = ',') {
  const result = [];
  let buf = '';
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quote) {
      buf += ch;
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '\'' || ch === '"' || ch === '`') { quote = ch; buf += ch; continue; }
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === delimiter && depth === 0) { result.push(buf.trim()); buf = ''; }
    else buf += ch;
  }
  if (buf.trim()) result.push(buf.trim());
  return result;
}

function unquoteIdent(s) {
  return String(s || '').trim().replace(/^[`"\[]|[`"\]]$/g, '');
}

function normalizeType(type) {
  return String(type || '').trim().replace(/\s+/g, ' ');
}

function parseCreateTables(sql) {
  const out = [];
  const re = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?((?:[`"\[]?[^\s(`"\]]+[`"\]]?\.)?[`"\[]?[^\s(`"\]]+[`"\]]?)\s*\(/ig;
  let m;
  while ((m = re.exec(sql))) {
    const rawName = m[1];
    let i = re.lastIndex;
    let depth = 1, quote = null, escaped = false;
    for (; i < sql.length && depth > 0; i++) {
      const ch = sql[i];
      if (quote) {
        if (escaped) { escaped = false; continue; }
        if (ch === '\\') { escaped = true; continue; }
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === '\'' || ch === '"' || ch === '`') { quote = ch; continue; }
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
    }
    if (depth !== 0) continue;
    const body = sql.slice(re.lastIndex, i - 1);
    re.lastIndex = i;
    const tableName = unquoteIdent(rawName.split('.').pop());
    const parts = splitTopLevel(body);
    const columns = [];
    const pk = new Set();
    const indexed = new Set();
    const refs = new Map();

    for (const part of parts) {
      const p = part.trim();
      let cm;
      if ((cm = p.match(/^(?:CONSTRAINT\s+\S+\s+)?PRIMARY\s+KEY\s*\(([^)]+)\)/i))) {
        splitTopLevel(cm[1]).forEach((x) => pk.add(unquoteIdent(x.split(/\s+/)[0])));
        continue;
      }
      if ((cm = p.match(/^(?:UNIQUE\s+)?(?:INDEX|KEY)\s+(?:[`"\[]?[^\s(]+[`"\]]?\s*)?\(([^)]+)\)/i))) {
        splitTopLevel(cm[1]).forEach((x) => indexed.add(unquoteIdent(x.split(/\s+/)[0])));
        continue;
      }
      if ((cm = p.match(/^(?:CONSTRAINT\s+\S+\s+)?FOREIGN\s+KEY\s*\(([^)]+)\)\s+REFERENCES\s+([^\s(]+)\s*\(([^)]+)\)/i))) {
        const local = splitTopLevel(cm[1]).map((x) => unquoteIdent(x.trim()));
        const remoteTable = unquoteIdent(cm[2].split('.').pop());
        const remote = splitTopLevel(cm[3]).map((x) => unquoteIdent(x.trim()));
        local.forEach((c, idx) => refs.set(c, { table: remoteTable, column: remote[idx] || remote[0] }));
        continue;
      }
      if (/^(?:CONSTRAINT|PRIMARY\s+KEY|FOREIGN\s+KEY|UNIQUE|INDEX|KEY|CHECK)\b/i.test(p)) continue;

      const nameMatch = p.match(/^([`"\[]?[^\s`"\]]+[`"\]]?)\s+(.+)$/s);
      if (!nameMatch) continue;
      const name = unquoteIdent(nameMatch[1]);
      const rest = nameMatch[2].trim();
      const stop = /\s+(?=NOT\s+NULL|NULL\b|DEFAULT\b|PRIMARY\s+KEY|UNIQUE\b|REFERENCES\b|COMMENT\b|COLLATE\b|CHECK\b|GENERATED\b|AUTO_INCREMENT\b)/i;
      const stopMatch = stop.exec(rest);
      const type = normalizeType(stopMatch ? rest.slice(0, stopMatch.index) : rest);
      const constraints = stopMatch ? rest.slice(stopMatch.index).trim() : '';
      const nullable = !/\bNOT\s+NULL\b/i.test(constraints);
      const inlinePk = /\bPRIMARY\s+KEY\b/i.test(constraints);
      const inlineUnique = /\bUNIQUE\b/i.test(constraints);
      const def = constraints.match(/\bDEFAULT\s+((?:'[^']*')|(?:"[^"]*")|(?:[^\s,]+))/i);
      const comment = constraints.match(/\bCOMMENT\s+'((?:''|[^'])*)'/i);
      const inlineRef = constraints.match(/\bREFERENCES\s+([^\s(]+)\s*\(([^)]+)\)/i);
      columns.push({
        name,
        data_type: type,
        nullable,
        primary_key: inlinePk,
        indexed: inlinePk || inlineUnique,
        default_value: def ? def[1] : '',
        ddl_comment: comment ? comment[1].replace(/''/g, "'") : '',
      });
      if (inlineRef) refs.set(name, { table: unquoteIdent(inlineRef[1].split('.').pop()), column: unquoteIdent(inlineRef[2].trim()) });
    }
    columns.forEach((c, idx) => {
      if (pk.has(c.name)) c.primary_key = true;
      if (pk.has(c.name) || indexed.has(c.name)) c.indexed = true;
      if (refs.has(c.name)) c.references = refs.get(c.name);
      c.order = (idx + 1) * 10;
    });
    out.push({ table: tableName, columns });
  }
  return out;
}

function diffRecords(existing, incoming, managedKeys) {
  const result = [];
  const existingMap = new Map(existing.map((r) => [r.key, r]));
  const incomingMap = new Map(incoming.map((r) => [r.key, r]));
  for (const inc of incoming) {
    const old = existingMap.get(inc.key);
    if (!old) { result.push({ key: inc.key, status: 'added', before: null, after: inc, changes: managedKeys }); continue; }
    const changes = managedKeys.filter((k) => JSON.stringify(old[k] ?? '') !== JSON.stringify(inc[k] ?? ''));
    result.push({ key: inc.key, status: changes.length ? 'changed' : 'unchanged', before: old, after: inc, changes });
  }
  for (const old of existing) {
    if (!incomingMap.has(old.key)) result.push({ key: old.key, status: 'removed', before: old, after: null, changes: [] });
  }
  return result;
}

function parseWikiTarget(value) {
  const s = String(value || '');
  const m = s.match(/^\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]$/);
  return m ? m[1] : s;
}

function makeApiFieldFilename(apiName, direction, path) {
  return `${sanitizeSegment(apiName)}__${sanitizeSegment(direction)}__${sanitizeSegment(path)}`;
}
function makeDbColumnFilename(table, column) {
  return `${sanitizeSegment(table)}__${sanitizeSegment(column)}`;
}
return {
  sanitizeSegment,
  inferScalarType,
  flattenJsonSample,
  splitTopLevel,
  parseCreateTables,
  diffRecords,
  parseWikiTarget,
  makeApiFieldFilename,
  makeDbColumnFilename,
};
})();


const DEFAULTS = {
  apiDocsFolder: '02-接口',
  dbDocsFolder: '03-数据库',
  apiFieldsFolder: '_data/api-fields',
  dbColumnsFolder: '_data/db-columns',
  apiBaseName: 'ApiFields.base',
  dbBaseName: 'DbColumns.base',
  prioritizeInlineSuggest: true,
  gridViewPrefs: {
    api: { hiddenProps: [], sorts: [], filters: [] },
    db: { hiddenProps: [], sorts: [], filters: [] },
  },
};

function bool(v, fallback = false) { return typeof v === 'boolean' ? v : fallback; }
function arrish(v) { return Array.isArray(v) ? v : (v == null ? [] : [v]); }
function fmLinkPath(v) { return core.parseWikiTarget(v || ''); }
function basenameNoExt(path) { return String(path || '').split('/').pop().replace(/\.md$/i, ''); }
function escHtml(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

async function ensureFolder(app, folder) {
  folder = normalizePath(folder || '');
  if (!folder) return;
  const parts = folder.split('/');
  let cur = '';
  for (const p of parts) {
    cur = cur ? `${cur}/${p}` : p;
    if (!app.vault.getAbstractFileByPath(cur)) await app.vault.createFolder(cur);
  }
}

function noteBodyApiField(apiName, direction, row) {
  const parent = row.parent_path ? `\n父路径：\`${row.parent_path}\`` : '';
  return `# ${apiName}.${direction}.${row.path}\n\n${row.description || '待补充说明。'}\n\n所属接口：[[${apiName}]]\n方向：\`${direction}\`\n路径：\`${row.path}\`\n结构：\`${row.shape}\` / \`${row.data_type}\`${parent}\n`;
}
function noteBodyDbColumn(table, row) {
  return `# ${table}.${row.name}\n\n${row.description || row.ddl_comment || '待补充说明。'}\n\n所属表：[[${table}]]\n`;
}


const FRONTMATTER_INTERNAL_KEYS = new Set(['position']);
const API_IMPORT_MANAGED_KEYS = ['direction','path','parent_path','name','shape','data_type','order'];
const DB_IMPORT_MANAGED_KEYS = ['name','data_type','nullable','primary_key','indexed','default_value','references','ddl_comment','order'];
const NON_EDITABLE_IDENTITY_KEYS = new Set(['api','table','direction','path','parent_path','name','order','schema_orphaned','schema_source','schema_dialect','last_imported_at']);

function normalizeFieldDefinition(raw) {
  if (!raw || !raw.name) return null;
  return {
    name: String(raw.name),
    type: String(raw.type || 'Input'),
    required: !!raw.required,
    options: Array.isArray(raw.options) ? raw.options.map(String) : [],
    default: raw.default,
  };
}
function defaultForField(def) {
  if (def && def.default !== undefined) return def.default;
  const type = String(def?.type || '').toLowerCase();
  if (type === 'boolean') return false;
  if (type.includes('multi')) return [];
  return '';
}
function stripCacheKeys(obj) {
  const out = {};
  for (const [k,v] of Object.entries(obj || {})) if (!FRONTMATTER_INTERNAL_KEYS.has(k)) out[k] = v;
  return out;
}
function normalizeDirection(value) {
  const s = String(value || '').trim().toLowerCase();
  if (['request','req','请求','入参'].includes(s)) return 'Request';
  if (['response','resp','res','响应','出参'].includes(s)) return 'Response';
  return '';
}
function parseJsonFilenameTarget(filename) {
  const base = String(filename || '').replace(/\.json$/i,'').trim();
  const m = base.match(/^(.+?)[._\-\s]+(request|response|req|resp|res|请求|响应|入参|出参)$/i);
  if (!m) return null;
  const direction = normalizeDirection(m[2]);
  return direction ? { apiName: m[1].trim(), direction } : null;
}
function extractJsonImportUnit(text, filename='', fallback={}) {
  const parsed = JSON.parse(text);
  let data = parsed;
  let meta = null;
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    if (parsed.__schema && typeof parsed.__schema === 'object' && !Array.isArray(parsed.__schema)) meta = parsed.__schema;
    else if (parsed._schema && typeof parsed._schema === 'object' && !Array.isArray(parsed._schema)) meta = parsed._schema;
  }
  const fromName = parseJsonFilenameTarget(filename);
  const apiName = String(meta?.api || meta?.apiName || meta?.interface || fromName?.apiName || fallback.apiName || '').trim();
  const direction = normalizeDirection(meta?.direction || fromName?.direction || fallback.direction);
  if (meta) {
    const key = String(meta.dataKey || meta.payloadKey || '').trim();
    if (key && Object.prototype.hasOwnProperty.call(parsed, key)) data = parsed[key];
    else if (Object.prototype.hasOwnProperty.call(parsed, 'payload')) data = parsed.payload;
    else if (Object.prototype.hasOwnProperty.call(parsed, 'body')) data = parsed.body;
    else if (Object.prototype.hasOwnProperty.call(parsed, 'data')) data = parsed.data;
    else {
      data = Object.fromEntries(Object.entries(parsed).filter(([k]) => k !== '__schema' && k !== '_schema'));
    }
  }
  if (!apiName || !direction) throw new Error(`无法确定导入目标：${filename || 'JSON 字符串'}。请使用“接口名.Request.json / 接口名.Response.json”，或在内容中提供 __schema.api + __schema.direction。`);
  return { apiName, direction, data, filename: filename || 'JSON 字符串' };
}
function diffValue(v) {
  if (v === undefined) return '—';
  if (v === null) return 'null';
  if (typeof v === 'string') return v === '' ? '（空）' : v;
  try { return JSON.stringify(v); } catch { return String(v); }
}
function detailedDiffRows(diff) {
  const rows = [];
  for (const d of diff || []) {
    if (d.status === 'unchanged') continue;
    if (d.status === 'changed') {
      for (const prop of d.changes || []) rows.push({ status:'changed', key:d.key, property:prop, before:d.before?.[prop], after:d.after?.[prop] });
    } else if (d.status === 'added') {
      const props = (d.changes || []).filter(k => d.after && d.after[k] !== undefined);
      if (!props.length) rows.push({ status:'added', key:d.key, property:'字段', before:undefined, after:'新增' });
      else for (const prop of props) rows.push({ status:'added', key:d.key, property:prop, before:undefined, after:d.after?.[prop] });
    } else if (d.status === 'removed') {
      rows.push({ status:'removed', key:d.key, property:'字段', before:'存在', after:'源中未出现（将标记疑似删除）' });
    }
  }
  return rows;
}

function parseClipboardTable(text) {
  const rows = []; let row = []; let cell = ''; let quoted = false;
  const src = String(text ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else {
      if (ch === '"' && cell === '') quoted = true;
      else if (ch === '\t') { row.push(cell); cell = ''; }
      else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
      else cell += ch;
    }
  }
  row.push(cell); rows.push(row);
  while (rows.length > 1 && rows[rows.length - 1].every(v => v === '')) rows.pop();
  return rows;
}
function clipboardValueForType(raw, def) {
  const type = String(def?.type || 'Input').toLowerCase();
  const s = String(raw ?? '').trim();
  if (type === 'boolean') {
    const l = s.toLowerCase();
    if (['true','1','yes','y','是','√','✓'].includes(l)) return true;
    if (['false','0','no','n','否','×','✗',''].includes(l)) return false;
    return !!s;
  }
  if (type === 'number') return s === '' ? '' : (Number.isFinite(Number(s)) ? Number(s) : s);
  if (type.includes('multi')) return s === '' ? [] : s.split(/[,，]/).map(x => x.trim()).filter(Boolean);
  return raw == null ? '' : String(raw);
}
function displayGridValue(v) {
  if (v === undefined || v === null || v === '') return '';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.join(', ');
  if (typeof v === 'object') { try { return JSON.stringify(v); } catch {} }
  return String(v);
}
function valuesEqual(a, b) {
  return JSON.stringify(a ?? '') === JSON.stringify(b ?? '');
}

const DEMO_ROOT = '_SchemaTools-Demo';

function demoPaths(root = DEMO_ROOT) {
  root = normalizePath(root);
  return {
    root,
    start: `${root}/00-开始这里.md`,
    design: `${root}/01-设计文档`,
    apiDocs: `${root}/02-接口`,
    dbDocs: `${root}/03-数据库`,
    apiFields: `${root}/_data/api-fields`,
    dbColumns: `${root}/_data/db-columns`,
    fileclasses: `${root}/_fileclasses`,
    bases: `${root}/_bases`,
    samples: `${root}/_samples`,
    apiBase: `${root}/_bases/ApiFields.base`,
    dbBase: `${root}/_bases/DbColumns.base`,
  };
}

function demoApiClass(paths) {
  return `---\nfilesPaths:\n  - ${paths.apiFields}\nfields:\n  - name: api\n    id: DEMOAF001\n    type: File\n    required: true\n    path: ''\n  - name: direction\n    id: DEMOAF002\n    type: Select\n    required: true\n    options: [Request, Response]\n    path: ''\n  - name: path\n    id: DEMOAF003\n    type: Input\n    required: true\n    path: ''\n  - name: parent_path\n    id: DEMOAF004\n    type: Input\n    required: false\n    path: ''\n  - name: name\n    id: DEMOAF005\n    type: Input\n    required: true\n    path: ''\n  - name: shape\n    id: DEMOAF006\n    type: Select\n    required: true\n    options: [Scalar, Object, List, List<Object>]\n    path: ''\n  - name: data_type\n    id: DEMOAF007\n    type: Input\n    required: true\n    path: ''\n  - name: required\n    id: DEMOAF008\n    type: Boolean\n    required: true\n    path: ''\n  - name: high_risk\n    id: DEMOAF009\n    type: Boolean\n    required: true\n    path: ''\n  - name: description\n    id: DEMOAF010\n    type: Input\n    required: true\n    path: ''\n  - name: db_column\n    id: DEMOAF011\n    type: File\n    required: false\n    path: ''\n  - name: reviewed\n    id: DEMOAF012\n    type: Boolean\n    required: true\n    path: ''\n  - name: order\n    id: DEMOAF013\n    type: Number\n    required: true\n    path: ''\n  - name: schema_orphaned\n    id: DEMOAF014\n    type: Boolean\n    required: true\n    path: ''\n---\n\n# 体验接口字段\n\n这是 Schema Tools 中文体验样例使用的接口字段 Fileclass。\n`;
}

function demoDbClass(paths) {
  return `---\nfilesPaths:\n  - ${paths.dbColumns}\nfields:\n  - name: table\n    id: DEMODC001\n    type: File\n    required: true\n    path: ''\n  - name: name\n    id: DEMODC002\n    type: Input\n    required: true\n    path: ''\n  - name: data_type\n    id: DEMODC003\n    type: Input\n    required: true\n    path: ''\n  - name: nullable\n    id: DEMODC004\n    type: Boolean\n    required: true\n    path: ''\n  - name: primary_key\n    id: DEMODC005\n    type: Boolean\n    required: true\n    path: ''\n  - name: indexed\n    id: DEMODC006\n    type: Boolean\n    required: true\n    path: ''\n  - name: high_risk\n    id: DEMODC007\n    type: Boolean\n    required: true\n    path: ''\n  - name: description\n    id: DEMODC008\n    type: Input\n    required: true\n    path: ''\n  - name: default_value\n    id: DEMODC009\n    type: Input\n    required: false\n    path: ''\n  - name: references\n    id: DEMODC010\n    type: File\n    required: false\n    path: ''\n  - name: order\n    id: DEMODC011\n    type: Number\n    required: true\n    path: ''\n  - name: schema_orphaned\n    id: DEMODC012\n    type: Boolean\n    required: true\n    path: ''\n---\n\n# 体验数据库字段\n\n这是 Schema Tools 中文体验样例使用的数据库字段 Fileclass。\n`;
}

function demoApiBase() {
  return `properties:\n  api:\n    displayName: 接口\n  direction:\n    displayName: 方向\n  path:\n    displayName: 路径\n  shape:\n    displayName: 结构\n  data_type:\n    displayName: 类型\n  required:\n    displayName: 必填\n  high_risk:\n    displayName: 高风险\n  description:\n    displayName: 说明\n  db_column:\n    displayName: 对应数据库字段\n  reviewed:\n    displayName: 已复核\nviews:\n  - type: fileclass-table\n    name: 当前接口 Request\n    filters:\n      and:\n        - fileClass.containsAny("体验接口字段")\n        - api == this.file.asLink()\n        - direction == "Request"\n    order: [path, shape, data_type, required, high_risk, description, db_column, reviewed]\n    sort:\n      - property: order\n        direction: ASC\n  - type: fileclass-table\n    name: 当前接口 Response\n    filters:\n      and:\n        - fileClass.containsAny("体验接口字段")\n        - api == this.file.asLink()\n        - direction == "Response"\n    order: [path, shape, data_type, required, high_risk, description, db_column, reviewed]\n    sort:\n      - property: order\n        direction: ASC\n  - type: fileclass-table\n    name: 全部接口字段\n    filters:\n      and:\n        - fileClass.containsAny("体验接口字段")\n    order: [api, direction, path, shape, data_type, required, high_risk, description, db_column, reviewed]\n`;
}

function demoDbBase() {
  return `properties:\n  table:\n    displayName: 数据表\n  name:\n    displayName: 字段\n  data_type:\n    displayName: 类型\n  nullable:\n    displayName: Nullable\n  primary_key:\n    displayName: PK\n  indexed:\n    displayName: 索引\n  high_risk:\n    displayName: 高风险\n  description:\n    displayName: 说明\n  references:\n    displayName: 引用\nviews:\n  - type: fileclass-table\n    name: 当前数据表\n    filters:\n      and:\n        - fileClass.containsAny("体验数据库字段")\n        - table == this.file.asLink()\n    order: [name, data_type, nullable, primary_key, indexed, high_risk, description, references]\n    sort:\n      - property: order\n        direction: ASC\n  - type: fileclass-table\n    name: 全部数据库字段\n    filters:\n      and:\n        - fileClass.containsAny("体验数据库字段")\n    order: [table, name, data_type, nullable, primary_key, indexed, high_risk, description, references]\n`;
}

function demoDescription(path) {
  const map = {
    buyer: '购买人', 'buyer.user_id': '用户 ID', 'buyer.contact': '联系人', 'buyer.contact.name': '联系人姓名', 'buyer.contact.mobile': '联系人手机号',
    items: '订单商品列表', 'items[].sku_id': 'SKU ID', 'items[].quantity': '购买数量', 'items[].price': '下单单价', 'items[].attributes': '商品销售属性', 'items[].attributes[].key': '属性名', 'items[].attributes[].value': '属性值',
    coupon_codes: '优惠券编码列表', payment: '支付信息', 'payment.channel': '支付渠道', 'payment.amount': '支付金额',
    order: '订单摘要', 'order.id': '订单 ID', 'order.order_no': '订单号', 'order.status': '订单状态', 'order.amount': '订单金额',
    timeline: '订单状态时间线', 'timeline[].status': '状态', 'timeline[].time': '状态时间', order_no: '订单号'
  };
  return map[path] || path.split('.').pop().replace(/\[\]/g, '');
}

function demoDbColumnLink(paths, table, column) {
  return `[[${paths.dbColumns}/${core.makeDbColumnFilename(table, column)}]]`;
}

function demoDbMapping(paths, path) {
  const map = {
    'buyer.user_id': ['orders','user_id'],
    'items[].sku_id': ['order_item','sku_id'],
    'items[].quantity': ['order_item','quantity'],
    'items[].price': ['order_item','price'],
    'payment.channel': ['orders','payment_channel'],
    'payment.amount': ['orders','amount'],
    'order.id': ['orders','id'],
    'order.order_no': ['orders','order_no'],
    'order.status': ['orders','status'],
    'order.amount': ['orders','amount'],
    order_no: ['orders','order_no'],
  };
  const hit = map[path];
  return hit ? demoDbColumnLink(paths, hit[0], hit[1]) : '';
}

function buildDemoFilePlan(root = DEMO_ROOT) {
  const p = demoPaths(root);
  const createOrderRequest = {
    buyer: { user_id: 10001, contact: { name: '张三', mobile: '13800000000' } },
    items: [{ sku_id: 20001, quantity: 2, price: 99.9, attributes: [{ key: '颜色', value: '红色' }] }],
    coupon_codes: ['新人满减券'],
    payment: { channel: '微信支付', amount: 199.8 },
  };
  const createOrderResponse = { order: { id: 90001, order_no: 'O202609120001', status: '已创建', amount: 199.8 } };
  const queryResponse = {
    order_no: 'O202609120001',
    buyer: { user_id: 10001, name: '张三', mobile: '13800000000' },
    items: [{ sku_id: 20001, name: '红色经典T恤', quantity: 2, attributes: [{ key: '颜色', value: '红色' }] }],
    timeline: [{ status: '已创建', time: '2026-09-12T10:00:00+08:00' }],
  };
  const requestV2 = {
    ...createOrderRequest,
    shipping_address: { province: '广东省', city: '深圳市', district: '南山区', detail: '科技园一号楼' },
    payment: { channel: '微信支付', amount: 199.8, currency: '人民币' },
  };
  const mysql = `CREATE TABLE orders (\n  id BIGINT NOT NULL PRIMARY KEY COMMENT '订单主键',\n  order_no VARCHAR(40) NOT NULL COMMENT '订单号',\n  user_id BIGINT NOT NULL COMMENT '购买用户ID',\n  amount DECIMAL(18,2) NOT NULL DEFAULT 0 COMMENT '订单金额',\n  payment_channel VARCHAR(20) COMMENT '支付渠道',\n  status VARCHAR(20) NOT NULL COMMENT '订单状态',\n  KEY idx_user (user_id),\n  UNIQUE KEY uk_order_no (order_no)\n);\n\nCREATE TABLE order_item (\n  id BIGINT NOT NULL PRIMARY KEY COMMENT '订单商品主键',\n  order_id BIGINT NOT NULL COMMENT '订单ID',\n  sku_id BIGINT NOT NULL COMMENT '商品SKU ID',\n  quantity INT NOT NULL COMMENT '购买数量',\n  price DECIMAL(18,2) NOT NULL COMMENT '下单单价',\n  KEY idx_order (order_id),\n  CONSTRAINT fk_item_order FOREIGN KEY (order_id) REFERENCES orders(id)\n);\n`;
  const mysqlV2 = mysql
    .replace("status VARCHAR(20) NOT NULL COMMENT '订单状态',", "status VARCHAR(40) NOT NULL COMMENT '订单状态',\n  currency VARCHAR(8) NOT NULL DEFAULT 'CNY' COMMENT '币种',")
    .replace("price DECIMAL(18,2) NOT NULL COMMENT '下单单价',", "price DECIMAL(18,2) NOT NULL COMMENT '下单单价',\n  discount_amount DECIMAL(18,2) NOT NULL DEFAULT 0 COMMENT '优惠金额',");
  const oracle = `CREATE TABLE ORDERS (\n  ID NUMBER(19) CONSTRAINT ORDERS_PK PRIMARY KEY,\n  ORDER_NO VARCHAR2(40) CONSTRAINT ORDERS_NO_NN NOT NULL,\n  USER_ID NUMBER(19) NOT NULL,\n  AMOUNT NUMBER(18,2) DEFAULT 0 NOT NULL,\n  STATUS VARCHAR2(20) NOT NULL\n);\nCOMMENT ON COLUMN ORDERS.ID IS '订单主键';\nCOMMENT ON COLUMN ORDERS.ORDER_NO IS '订单号';\nCOMMENT ON COLUMN ORDERS.USER_ID IS '购买用户ID';\nCOMMENT ON COLUMN ORDERS.AMOUNT IS '订单金额';\nCOMMENT ON COLUMN ORDERS.STATUS IS '订单状态';\nCREATE INDEX IDX_ORDERS_USER ON ORDERS(USER_ID);\n`;

  const files = [];
  const add = (path, content) => files.push({ path: normalizePath(path), content });
  add(`${p.fileclasses}/体验接口字段.md`, demoApiClass(p));
  add(`${p.fileclasses}/体验数据库字段.md`, demoDbClass(p));
  add(p.apiBase, demoApiBase());
  add(p.dbBase, demoDbBase());

  const apiDocs = [
    ['创建订单', createOrderRequest, createOrderResponse],
    ['查询订单详情', null, queryResponse],
  ];
  for (const [apiName, request, response] of apiDocs) {
    const apiDocPath = `${p.apiDocs}/${apiName}.md`;
    add(apiDocPath, `# ${apiName}\n\n这是 Schema Tools 中文体验样例中的接口文档。\n\n## 请求参数\n\n![[${p.apiBase}#当前接口 Request]]\n\n## 响应参数\n\n![[${p.apiBase}#当前接口 Response]]\n`);
    for (const [direction, sample] of [['Request',request],['Response',response]]) {
      if (sample == null) continue;
      const rows = core.flattenJsonSample(sample);
      for (const row of rows) {
        const required = !['coupon_codes','items[].attributes'].includes(row.path);
        const highRisk = row.path.endsWith('mobile');
        const props = {
          fileClass: '体验接口字段',
          api: `[[${apiDocPath.replace(/\.md$/,'')}]]`,
          direction,
          path: row.path,
          parent_path: row.parent_path || '',
          name: row.name,
          shape: row.shape,
          data_type: row.data_type,
          required,
          high_risk: highRisk,
          description: demoDescription(row.path),
          db_column: demoDbMapping(p, row.path),
          reviewed: true,
          order: row.order,
          schema_orphaned: false,
        };
        const fp = `${p.apiFields}/${core.makeApiFieldFilename(apiName,direction,row.path)}.md`;
        add(fp, `---\n${stringifyYaml(props)}---\n\n${noteBodyApiField(apiName,direction,props)}`);
      }
    }
  }

  const dbTables = {
    orders: [
      ['id','BIGINT',false,true,true,false,'订单主键',''],
      ['order_no','VARCHAR(40)',false,false,true,false,'订单号',''],
      ['user_id','BIGINT',false,false,true,false,'购买用户ID',''],
      ['amount','DECIMAL(18,2)',false,false,false,true,'订单金额',''],
      ['payment_channel','VARCHAR(20)',true,false,false,false,'支付渠道',''],
      ['status','VARCHAR(20)',false,false,false,false,'订单状态',''],
    ],
    order_item: [
      ['id','BIGINT',false,true,true,false,'订单商品主键',''],
      ['order_id','BIGINT',false,false,true,false,'订单ID',demoDbColumnLink(p,'orders','id')],
      ['sku_id','BIGINT',false,false,false,false,'商品SKU ID',''],
      ['quantity','INT',false,false,false,false,'购买数量',''],
      ['price','DECIMAL(18,2)',false,false,false,false,'下单单价',''],
    ],
  };
  for (const [table, cols] of Object.entries(dbTables)) {
    const tableDocPath = `${p.dbDocs}/${table}.md`;
    const tableTitle = table === 'orders' ? 'orders（订单表）' : table === 'order_item' ? 'order_item（订单商品表）' : table;
    add(tableDocPath, `# ${tableTitle}\n\n这是 Schema Tools 中文体验样例中的数据库表。\n\n## 字段\n\n![[${p.dbBase}#当前数据表]]\n`);
    cols.forEach((c, i) => {
      const [name,data_type,nullable,primary_key,indexed,high_risk,description,references] = c;
      const props = { fileClass:'体验数据库字段', table:`[[${tableDocPath.replace(/\.md$/,'')}]]`, name, data_type, nullable, primary_key, indexed, high_risk, description, order:(i+1)*10, schema_orphaned:false };
      if (references) props.references = references;
      const fp = `${p.dbColumns}/${core.makeDbColumnFilename(table,name)}.md`;
      add(fp, `---\n${stringifyYaml(props)}---\n\n${noteBodyDbColumn(table,props)}`);
    });
  }

  add(`${p.design}/订单创建设计.md`, `# 订单创建设计\n\n这个文档用于体验设计文档中的精准引用。\n\n## 业务说明\n\n创建订单时，需要记录购买人、商品明细、优惠券和支付信息。商品明细中的 SKU 会落库到订单商品表。\n\n## 精准引用体验\n\n在正文输入 \`[[@\`，依次选择：\n\n- 接口字段 → 创建订单 → Request → items → sku_id\n- 数据库字段 → order_item → sku_id\n\n示例关系：创建订单中的商品 SKU 最终写入 [[${p.dbColumns}/${core.makeDbColumnFilename('order_item','sku_id')}|order_item.sku_id]]。\n`);
  add(`${p.samples}/创建订单-请求.json`, JSON.stringify({__schema:{api:'创建订单',direction:'请求'},payload:createOrderRequest}, null, 2));
  add(`${p.samples}/创建订单-响应.json`, JSON.stringify({__schema:{api:'创建订单',direction:'响应'},payload:createOrderResponse}, null, 2));
  add(`${p.samples}/创建订单-请求-v2.json`, JSON.stringify({__schema:{api:'创建订单',direction:'请求'},payload:requestV2}, null, 2));
  add(`${p.samples}/订单表-MySQL.sql`, mysql);
  add(`${p.samples}/订单表-MySQL-v2.sql`, mysqlV2);
  add(`${p.samples}/订单表-Oracle.sql`, oracle);
  add(p.start, `# Schema Tools 中文体验样例\n\n> 样例中的接口名称、文档说明、JSON 字符串值、DDL 注释和引导内容均使用中文；字段名、表名等技术标识保留工程中常见的英文命名。\n\n本样例的所有文件都位于 **${p.root}/**，不会把接口、数据库、字段记录散落到 Vault 根目录。\n\n## 推荐体验顺序\n\n1. 点击左侧 Ribbon 的 **Schema Studio**，浏览“创建订单”和数据库表。\n2. 在 [[${p.design}/订单创建设计|订单创建设计]] 中输入 \`[[@\`，体验逐层精准引用。\n3. 打开 [[${p.apiDocs}/创建订单|创建订单]]，体验 Fileclass + Bases 的接口字段表。\n4. Schema Studio → 创建订单 → **JSON 导入 / 更新**，选择 [[${p.samples}/创建订单-请求-v2.json|创建订单-请求-v2.json]]，查看单元格内 \`旧值 → 新值\` 的差异。\n5. 数据库 → orders → **DDL 导入 / 更新**，使用 [[${p.samples}/订单表-MySQL-v2.sql|订单表-MySQL-v2.sql]]。\n6. 在 Schema Studio 字段表中体验 Excel/WPS 多单元格复制粘贴、排序、筛选、属性、搜索与新建。\n\n## 关于配置\n\n安装样例时，Schema Tools 会临时切换 API/数据库相关目录到本样例目录；如果已安装 Fileclass，还会把 **Class files folder** 临时切到 \`${p.fileclasses}\`。原配置已备份。\n\n完成体验后运行命令：\n\n**API & DB Schema Tools: 退出体验样例并恢复插件配置**\n\n它只恢复配置，不会自动删除 \`${p.root}/\`，避免误删你在样例中做的修改。\n`);
  return { paths:p, files };
}
function getFileclassPlugin(app) {
  return app?.plugins?.plugins?.fileclass || null;
}

function getFileclassClassPath(fileclass) {
  return String(fileclass?.settings?.classFilesPath || '');
}

async function setFileclassClassPath(fileclass, path) {
  if (!fileclass?.settings) return false;
  const normalized = path ? `${normalizePath(path).replace(/\/$/,'')}/` : '';
  fileclass.settings.classFilesPath = normalized;
  if (typeof fileclass.saveSettings === 'function') await fileclass.saveSettings();
  else if (typeof fileclass.saveData === 'function') await fileclass.saveData(fileclass.settings);
  return true;
}

class DemoInstallModal extends Modal {
  constructor(app, plugin) { super(app); this.plugin = plugin; this.plan = buildDemoFilePlan(); }
  onOpen() {
    const { contentEl } = this; contentEl.empty();
    contentEl.createEl('h2', { text:'安装 Schema Tools 中文体验样例' });
    contentEl.createEl('p', { text:`只会在 Vault 根目录新增一个目录：${this.plan.paths.root}/。样例共 ${this.plan.files.length} 个文件，全部位于该目录内。` });
    const callout = contentEl.createDiv({ cls:'schema-tools-demo-callout' });
    callout.createEl('strong', { text:'安装会修改插件配置，请确认：' });
    const ul = callout.createEl('ul');
    const settingsChanges = [
      ['Schema Tools · 接口文档目录', this.plugin.settings.apiDocsFolder, this.plan.paths.apiDocs],
      ['Schema Tools · 数据库文档目录', this.plugin.settings.dbDocsFolder, this.plan.paths.dbDocs],
      ['Schema Tools · 接口字段目录', this.plugin.settings.apiFieldsFolder, this.plan.paths.apiFields],
      ['Schema Tools · 数据库字段目录', this.plugin.settings.dbColumnsFolder, this.plan.paths.dbColumns],
      ['Schema Tools · API Base', this.plugin.settings.apiBaseName, this.plan.paths.apiBase],
      ['Schema Tools · DB Base', this.plugin.settings.dbBaseName, this.plan.paths.dbBase],
    ];
    for (const [name,before,after] of settingsChanges) ul.createEl('li', { text:`${name}：${before || '（空）'} → ${after}` });
    const fc = getFileclassPlugin(this.app);
    if (fc) {
      const oldFc = getFileclassClassPath(fc);
      ul.createEl('li', { text:`Fileclass · Class files folder：${oldFc || '（空）'} → ${this.plan.paths.fileclasses}/` });
      if (oldFc && normalizePath(oldFc) !== normalizePath(this.plan.paths.fileclasses)) {
        const impact = contentEl.createDiv({ cls:'schema-tools-demo-warning' });
        impact.setText('注意：切换 Fileclass Class files folder 后，你当前 class 目录中的类会暂时不参与 Fileclass 解析；运行“退出体验样例并恢复插件配置”后会恢复原路径。');
      }
    } else ul.createEl('li', { text:'Fileclass：未安装，不修改。样例仍可在 Schema Studio 中使用，但 .base 的 typed editing 需要安装并配置 Fileclass。' });
    contentEl.createEl('p', { text:'切换期间 Schema Studio 也只浏览样例目录中的接口/数据库；不会移动、改写或删除现有业务文件。退出样例模式可一键恢复上述插件配置；样例目录会保留，避免误删你的体验修改。', cls:'schema-tools-muted' });
    const existing = this.app.vault.getAbstractFileByPath(this.plan.paths.root);
    if (existing) {
      const warn = contentEl.createDiv({ cls:'schema-tools-demo-warning' });
      warn.setText(`检测到 ${this.plan.paths.root}/ 已存在。为避免覆盖，安装命令不会修改其中任何文件。如果这是旧版本样例，请先恢复配置并自行重命名或删除该目录，再重新安装中文样例。`);
    }
    const actions = contentEl.createDiv({ cls:'schema-tools-actions' });
    const cancel = actions.createEl('button', { text:'取消' }); cancel.onclick=()=>this.close();
    if (existing) {
      const open = actions.createEl('button', { text:'只打开入口' });
      open.onclick=async()=>{ this.close(); await this.plugin.openDemoStart(); };
      const activate = actions.createEl('button', { text:this.plugin.settings.demoState?.active ? '样例模式已启用' : '切换到现有样例', cls:'mod-cta' });
      activate.disabled = !!this.plugin.settings.demoState?.active;
      activate.onclick=async()=>{ activate.disabled=true; try { await this.plugin.activateExistingDemo(this.plan); this.close(); } catch(e) { new Notice(`切换失败：${e.message}`); activate.disabled=false; } };
    } else {
      const install = actions.createEl('button', { text:'创建样例并切换配置', cls:'mod-cta' });
      install.onclick=async()=>{ install.disabled=true; try { await this.plugin.installDemo(this.plan); this.close(); } catch(e) { console.error(e); new Notice(`样例安装失败：${e.message}`); install.disabled=false; } };
    }
  }
  onClose(){ this.contentEl.empty(); }
}

class DemoRestoreModal extends Modal {
  constructor(app, plugin) { super(app); this.plugin=plugin; }
  onOpen(){
    const {contentEl}=this; contentEl.empty(); contentEl.createEl('h2',{text:'退出 Schema Tools 体验样例'});
    const state=this.plugin.settings.demoState;
    if(!state?.active){ contentEl.createEl('p',{text:'当前没有处于体验样例模式。'}); const b=contentEl.createEl('button',{text:'关闭'});b.onclick=()=>this.close();return; }
    contentEl.createEl('p',{text:'将恢复安装样例前备份的 Schema Tools 配置；如果安装时修改了 Fileclass Class files folder，也会恢复。'});
    contentEl.createEl('p',{text:`不会删除 ${state.root || DEMO_ROOT}/，避免误删你在样例中的修改。`,cls:'schema-tools-muted'});
    const actions=contentEl.createDiv({cls:'schema-tools-actions'}); const cancel=actions.createEl('button',{text:'取消'});cancel.onclick=()=>this.close(); const restore=actions.createEl('button',{text:'恢复配置并退出样例',cls:'mod-cta'});restore.onclick=async()=>{restore.disabled=true;try{await this.plugin.restoreDemoSettings();this.close();}catch(e){new Notice(`恢复失败：${e.message}`);restore.disabled=false;}};
  }
  onClose(){this.contentEl.empty();}
}


class SchemaToolsPlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULTS, await this.loadData());
    this.addSettingTab(new SchemaToolsSettingTab(this.app, this));

    // Register our suggester normally, then move only this suggester ahead of the
    // native wikilink suggester. Obsidian stops at the first EditorSuggest whose
    // onTrigger() returns a context. SchemaInlineSuggest returns null for every
    // input except [[@..., so normal [[ links still fall through to Obsidian.
    this.schemaInlineSuggest = new SchemaInlineSuggest(this);
    this.registerEditorSuggest(this.schemaInlineSuggest);
    this.setSchemaInlineSuggestPriority(this.settings.prioritizeInlineSuggest !== false);

    this.addRibbonIcon('database', 'Schema Studio', () => {
      new SchemaStudioModal(this.app, this).open();
    });
    this.addCommand({
      id: 'open-schema-studio',
      name: '打开 Schema Studio',
      callback: () => new SchemaStudioModal(this.app, this).open(),
    });
    this.addCommand({
      id: 'install-demo-sample',
      name: '安装 / 打开体验样例',
      callback: () => new DemoInstallModal(this.app, this).open(),
    });
    this.addCommand({
      id: 'restore-from-demo-sample',
      name: '退出体验样例并恢复插件配置',
      callback: () => new DemoRestoreModal(this.app, this).open(),
    });
  }
  async saveSettings() { await this.saveData(this.settings); }

  async createDemoFiles(plan) {
    for (const item of plan.files) {
      const parent = item.path.includes('/') ? item.path.slice(0, item.path.lastIndexOf('/')) : '';
      if (parent) await ensureFolder(this.app, parent);
      if (this.app.vault.getAbstractFileByPath(item.path)) throw new Error(`目标已存在：${item.path}`);
      await this.app.vault.create(item.path, item.content);
    }
  }

  async activateDemoSettings(plan = buildDemoFilePlan()) {
    if (this.settings.demoState?.active) return;
    const previousSchemaSettings = {
      apiDocsFolder: this.settings.apiDocsFolder,
      dbDocsFolder: this.settings.dbDocsFolder,
      apiFieldsFolder: this.settings.apiFieldsFolder,
      dbColumnsFolder: this.settings.dbColumnsFolder,
      apiBaseName: this.settings.apiBaseName,
      dbBaseName: this.settings.dbBaseName,
    };
    const fc = getFileclassPlugin(this.app);
    const previousFileclassPath = fc ? getFileclassClassPath(fc) : null;
    this.settings.demoState = {
      active: true,
      root: plan.paths.root,
      installedAt: new Date().toISOString(),
      previousSchemaSettings,
      fileclassInstalled: !!fc,
      previousFileclassPath,
    };
    Object.assign(this.settings, {
      apiDocsFolder: plan.paths.apiDocs,
      dbDocsFolder: plan.paths.dbDocs,
      apiFieldsFolder: plan.paths.apiFields,
      dbColumnsFolder: plan.paths.dbColumns,
      apiBaseName: plan.paths.apiBase,
      dbBaseName: plan.paths.dbBase,
      gridViewPrefs: { api:{ hiddenProps:[], sorts:[], filters:[] }, db:{ hiddenProps:[], sorts:[], filters:[] } },
    });
    await this.saveSettings();
    if (fc) await setFileclassClassPath(fc, plan.paths.fileclasses);
  }

  async installDemo(plan = buildDemoFilePlan()) {
    if (this.app.vault.getAbstractFileByPath(plan.paths.root)) throw new Error(`样例目录已存在：${plan.paths.root}`);
    await this.createDemoFiles(plan);
    await this.activateDemoSettings(plan);
    new Notice(`体验样例已创建：${plan.paths.root}/`);
    await this.openDemoStart();
  }

  async activateExistingDemo(plan = buildDemoFilePlan()) {
    if (!this.app.vault.getAbstractFileByPath(plan.paths.start)) throw new Error('现有样例不完整：缺少 00-开始这里.md');
    await this.activateDemoSettings(plan);
    new Notice('已切换到现有体验样例配置');
    await this.openDemoStart();
  }

  async openDemoStart() {
    const root = this.settings.demoState?.root || DEMO_ROOT;
    const file = this.app.vault.getAbstractFileByPath(`${normalizePath(root)}/00-开始这里.md`);
    if (file instanceof TFile) await this.app.workspace.getLeaf(true).openFile(file);
    else new Notice('没有找到体验样例入口文档');
  }

  async restoreDemoSettings() {
    const state = this.settings.demoState;
    if (!state?.active) { new Notice('当前没有处于体验样例模式'); return; }
    Object.assign(this.settings, state.previousSchemaSettings || {});
    this.settings.demoState = Object.assign({}, state, { active:false, restoredAt:new Date().toISOString() });
    await this.saveSettings();
    const fc = getFileclassPlugin(this.app);
    if (fc && state.fileclassInstalled) await setFileclassClassPath(fc, state.previousFileclassPath || '');
    new Notice('已恢复安装体验样例前的插件配置。样例目录仍保留。');
  }

  setSchemaInlineSuggestPriority(enabled) {
    // Compatibility switch: Obsidian has no public EditorSuggest priority API.
    // When enabled we move only our own suggester to the front so [[@ can beat
    // the native wikilink suggester. When disabled we move it to the end. This
    // gives users a reversible A/B test for plugin conflicts without disabling
    // Schema Studio itself.
    try {
      const list = this.app?.workspace?.editorSuggest?.suggests;
      if (!Array.isArray(list) || !this.schemaInlineSuggest) return;
      const index = list.indexOf(this.schemaInlineSuggest);
      if (index >= 0) list.splice(index, 1);
      if (enabled) list.unshift(this.schemaInlineSuggest);
      else list.push(this.schemaInlineSuggest);
    } catch (error) {
      console.warn('[API & DB Schema Tools] Could not change inline schema suggester priority.', error);
    }
  }

  findFileClassForFolder(folder) {
    const target = normalizePath(folder || '');
    for (const file of this.app.vault.getMarkdownFiles()) {
      const fm = this.app.metadataCache.getFileCache(file)?.frontmatter || {};
      const paths = arrish(fm.filesPaths).map(x => normalizePath(String(x || '')));
      if (paths.includes(target) && Array.isArray(fm.fields)) {
        return { file, className: basenameNoExt(file.path), fields: fm.fields.map(normalizeFieldDefinition).filter(Boolean) };
      }
    }
    return null;
  }

  getFieldDefinitions(domain) {
    const folder = domain === 'api' ? this.settings.apiFieldsFolder : this.settings.dbColumnsFolder;
    const cls = this.findFileClassForFolder(folder);
    const defs = new Map((cls?.fields || []).map(d => [d.name, d]));
    const rows = domain === 'api' ? this.scanApiFields() : this.scanDbColumns();
    for (const row of rows) for (const key of Object.keys(row.fm || {})) {
      if (FRONTMATTER_INTERNAL_KEYS.has(key) || key === 'fileClass' || ['schema_source','schema_dialect','schema_orphaned','last_imported_at'].includes(key)) continue;
      if (!defs.has(key)) defs.set(key, { name:key, type:typeof row.fm[key] === 'boolean' ? 'Boolean' : typeof row.fm[key] === 'number' ? 'Number' : 'Input', required:false, options:[] });
    }
    return { className: cls?.className || (domain === 'api' ? 'ApiField' : 'DbColumn'), fields:[...defs.values()] };
  }

  defaultPropertiesForDomain(domain) {
    const schema = this.getFieldDefinitions(domain);
    const out = { fileClass: schema.className };
    for (const def of schema.fields) out[def.name] = defaultForField(def);
    return out;
  }

  scanApiFields() {
    const prefix = normalizePath(this.settings.apiFieldsFolder) + '/';
    return this.app.vault.getMarkdownFiles().filter(f => f.path.startsWith(prefix)).map(file => {
      const fm = stripCacheKeys(this.app.metadataCache.getFileCache(file)?.frontmatter || {});
      const apiPath = fmLinkPath(fm.api);
      return {
        file, filePath: file.path, apiPath, apiName: basenameNoExt(apiPath),
        direction: fm.direction || '', path: fm.path || '', parent_path: fm.parent_path || '',
        name: fm.name || basenameNoExt(file.path), shape: fm.shape || '', data_type: fm.data_type || '',
        schema_orphaned: bool(fm.schema_orphaned), order: Number(fm.order || 0), fm,
      };
    }).filter(x => x.apiName && x.direction && x.path);
  }
  scanDbColumns() {
    const prefix = normalizePath(this.settings.dbColumnsFolder) + '/';
    return this.app.vault.getMarkdownFiles().filter(f => f.path.startsWith(prefix)).map(file => {
      const fm = stripCacheKeys(this.app.metadataCache.getFileCache(file)?.frontmatter || {});
      const tablePath = fmLinkPath(fm.table);
      return {
        file, filePath: file.path, tablePath, table: basenameNoExt(tablePath), name: fm.name || basenameNoExt(file.path),
        data_type: fm.data_type || '', nullable: bool(fm.nullable, true), primary_key: bool(fm.primary_key),
        indexed: bool(fm.indexed), schema_orphaned: bool(fm.schema_orphaned),
        default_value: fm.default_value ?? '', references: fm.references || '', ddl_comment: fm.ddl_comment || '',
        order: Number(fm.order || 0), fm,
      };
    }).filter(x => x.table && x.name);
  }
}

class SchemaToolsSettingTab extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
  display() {
    const { containerEl } = this; containerEl.empty();
    containerEl.createEl('h2', { text: 'Schema Tools' });
    const fields = [
      ['apiDocsFolder','接口文档目录'],['dbDocsFolder','数据库文档目录'],
      ['apiFieldsFolder','接口字段记录目录'],['dbColumnsFolder','数据库字段记录目录'],
    ];
    for (const [key, name] of fields) {
      new Setting(containerEl).setName(name).addText(t => t.setValue(this.plugin.settings[key]).onChange(async v => {
        this.plugin.settings[key] = v.trim(); await this.plugin.saveSettings();
      }));
    }
    new Setting(containerEl)
      .setName('让 [[@ Schema 联想优先于原生 Wikilink')
      .setDesc('默认开启。关闭后 Schema Studio 仍可使用，但 [[@ 可能被 Obsidian 原生链接联想抢先。该开关也用于排查与 Bases / Fileclass 的兼容性问题。')
      .addToggle(t => t.setValue(this.plugin.settings.prioritizeInlineSuggest !== false).onChange(async v => {
        this.plugin.settings.prioritizeInlineSuggest = v;
        await this.plugin.saveSettings();
        this.plugin.setSchemaInlineSuggestPriority(v);
        new Notice(v ? '已启用 [[@ 联想优先级' : '已关闭 [[@ 联想优先级（兼容测试模式）');
      }));
  }
}


class SchemaInlineSuggest extends EditorSuggest {
  constructor(plugin) {
    super(plugin.app);
    this.plugin = plugin;
    this.lastContext = null;
  }

  onTrigger(cursor, editor, file) {
    const line = editor.getLine(cursor.line);
    const before = line.slice(0, cursor.ch);
    // Deliberately do NOT trigger on plain [[. Only [[@ belongs to Schema Tools.
    // This keeps Obsidian's native wikilink suggester untouched for every normal link.
    const match = before.match(/\[\[@([^\]\n]*)$/);
    if (!match) return null;
    const startCh = before.lastIndexOf('[[ @'.replace(' ', ''));
    if (startCh < 0) return null;
    return {
      start: { line: cursor.line, ch: startCh },
      end: cursor,
      query: match[1],
    };
  }

  getSuggestions(context) {
    this.lastContext = context;
    return this.buildSuggestions(context.query || '');
  }

  buildSuggestions(query) {
    const parts = String(query).split('/');
    const mode = (parts[0] || '').toLowerCase();

    // Root: [[@  -> choose only the schema domain. A typed term filters this layer.
    if (!query.includes('/') && mode !== 'api' && mode !== 'db') {
      const term = mode;
      return [
        { kind: 'nav', label: '接口字段', detail: '接口 → Request/Response → Object/List → 字段', next: 'api/' },
        { kind: 'nav', label: '数据库字段', detail: '数据库表 → 列', next: 'db/' },
      ].filter(x => !term || x.label.includes(term) || x.next.startsWith(term));
    }

    if (mode === 'api') return this.buildApiSuggestions(parts);
    if (mode === 'db') return this.buildDbSuggestions(parts);
    return [];
  }

  buildApiSuggestions(parts) {
    const rows = this.plugin.scanApiFields().filter(x => !x.schema_orphaned);
    // api/<interface-filter>
    if (parts.length <= 2) {
      const term = parts[1] || '';
      const by = new Map();
      for (const r of rows) {
        if (!by.has(r.apiName)) by.set(r.apiName, r);
      }
      return [...by.values()]
        .filter(r => this.matches(r.apiName, term))
        .sort((a,b) => a.apiName.localeCompare(b.apiName, 'zh-CN'))
        .map(r => ({ kind:'nav', label:r.apiName, detail:'接口文档', next:`api/${r.apiName}/` }));
    }

    const apiName = parts[1];
    const apiRows = rows.filter(r => r.apiName === apiName);
    if (!apiRows.length) return [];

    // api/<interface>/<direction-filter>
    if (parts.length <= 3) {
      const term = parts[2] || '';
      const dirs = [...new Set(apiRows.map(r => r.direction))];
      return dirs
        .filter(d => this.matches(d, term))
        .sort((a,b) => a.localeCompare(b))
        .map(d => ({ kind:'nav', label:d, detail:`${apiRows.filter(r=>r.direction===d).length} 个 Schema 节点`, next:`api/${apiName}/${d}/` }));
    }

    const direction = parts[2];
    const dirRows = apiRows.filter(r => r.direction === direction);
    if (!dirRows.length) return [];

    const completedNames = parts.slice(3, -1).filter(Boolean);
    const term = parts[parts.length - 1] || '';
    let parent = '';
    for (const name of completedNames) {
      const node = dirRows.find(r => (r.parent_path || '') === parent && r.name === name);
      if (!node) return [];
      parent = node.path;
    }

    const children = dirRows
      .filter(r => (r.parent_path || '') === parent && this.matches(r.name, term))
      .sort((a,b) => (a.order-b.order) || a.name.localeCompare(b.name, 'zh-CN'));

    const prefix = `api/${apiName}/${direction}/${completedNames.length ? completedNames.join('/') + '/' : ''}`;
    return children.map(r => {
      const isContainer = r.shape === 'Object' || r.shape === 'List<Object>';
      if (isContainer) {
        return {
          kind:'nav', label:r.name,
          detail:`${r.shape} · ${r.path}`,
          next:`${prefix}${r.name}/`,
        };
      }
      return {
        kind:'leaf', label:r.name,
        detail:`${r.data_type}${r.required?' · 必填':''}${r.high_risk?' · 高风险':''} · ${r.path}`,
        record:r,
        domain:'api',
      };
    });
  }

  buildDbSuggestions(parts) {
    const rows = this.plugin.scanDbColumns().filter(x => !x.schema_orphaned);
    // db/<table-filter>
    if (parts.length <= 2) {
      const term = parts[1] || '';
      const by = new Map();
      for (const r of rows) if (!by.has(r.table)) by.set(r.table, r);
      return [...by.values()]
        .filter(r => this.matches(r.table, term))
        .sort((a,b) => a.table.localeCompare(b.table))
        .map(r => ({ kind:'nav', label:r.table, detail:'数据库表', next:`db/${r.table}/` }));
    }

    const table = parts[1];
    const term = parts[2] || '';
    return rows
      .filter(r => r.table === table && this.matches(r.name, term))
      .sort((a,b) => (a.order-b.order) || a.name.localeCompare(b.name))
      .map(r => ({
        kind:'leaf', label:r.name,
        detail:`${r.data_type}${r.primary_key?' · PK':''}${!r.nullable?' · NOT NULL':''}${r.high_risk?' · 高风险':''}`,
        record:r,
        domain:'db',
      }));
  }

  matches(value, term) {
    if (!term) return true;
    return String(value || '').toLowerCase().includes(String(term).toLowerCase());
  }

  renderSuggestion(item, el) {
    el.addClass('schema-tools-inline-suggestion');
    const row = el.createDiv({ cls:'schema-tools-inline-row' });
    row.createDiv({ text: item.kind === 'nav' ? `› ${item.label}` : item.label, cls:'schema-tools-inline-title' });
    if (item.detail) row.createDiv({ text:item.detail, cls:'schema-tools-inline-detail' });
  }

  selectSuggestion(item, evt) {
    const ctx = this.context || this.lastContext;
    if (!ctx) return;
    const editor = ctx.editor;
    if (item.kind === 'nav') {
      editor.replaceRange(`[[@${item.next}`, ctx.start, ctx.end);
      return;
    }
    if (item.domain === 'api') {
      const r = item.record;
      const alias = `${r.apiName}.${r.direction}.${r.path}`;
      editor.replaceRange(`[[${r.filePath.replace(/\.md$/,'')}|${alias}]]`, ctx.start, ctx.end);
      return;
    }
    if (item.domain === 'db') {
      const r = item.record;
      const alias = `${r.table}.${r.name}`;
      editor.replaceRange(`[[${r.filePath.replace(/\.md$/,'')}|${alias}]]`, ctx.start, ctx.end);
    }
  }
}


// --- DDL dialect adapters -------------------------------------------------
// Main UI/diff/apply code consumes one normalized shape regardless of dialect:
// { table, columns: [{ name, data_type, nullable, primary_key, indexed,
//   default_value, ddl_comment, references, order }] }
// Adding a dialect only requires registering another adapter below.

function tableKey(name) {
  return String(name || '').replace(/^[`"\[]|[`"\]]$/g, '').split('.').pop().toLowerCase();
}

function findParsedTable(parsed, rawName) {
  const key = tableKey(rawName);
  return parsed.find(t => tableKey(t.table) === key);
}

function findColumn(table, rawName) {
  if (!table) return null;
  const key = String(rawName || '').replace(/^[`"\[]|[`"\]]$/g, '').toLowerCase();
  return table.columns.find(c => String(c.name || '').toLowerCase() === key) || null;
}

function markIndexColumns(parsed, sql) {
  const re = /CREATE\s+(UNIQUE\s+)?INDEX\s+(?:[`"\[]?[^\s`"\]]+[`"\]]?)\s+ON\s+((?:[`"\[]?[^\s(`"\]]+[`"\]]?\.)?[`"\[]?[^\s(`"\]]+[`"\]]?)\s*\(([^)]+)\)/ig;
  let m;
  while ((m = re.exec(sql))) {
    const table = findParsedTable(parsed, m[2]);
    if (!table) continue;
    core.splitTopLevel(m[3]).forEach(part => {
      const col = findColumn(table, part.trim().split(/\s+/)[0]);
      if (col) col.indexed = true;
    });
  }
}

function applyAlterTableConstraints(parsed, sql) {
  const re = /ALTER\s+TABLE\s+((?:[`"\[]?[^\s`"\]]+[`"\]]?\.)?[`"\[]?[^\s`"\]]+[`"\]]?)\s+ADD\s+(?:CONSTRAINT\s+(?:[`"\[]?[^\s`"\]]+[`"\]]?)\s+)?([\s\S]*?);/ig;
  let m;
  while ((m = re.exec(sql))) {
    const table = findParsedTable(parsed, m[1]);
    if (!table) continue;
    const clause = m[2].trim();
    let cm;
    if ((cm = clause.match(/^PRIMARY\s+KEY\s*\(([^)]+)\)/i))) {
      core.splitTopLevel(cm[1]).forEach(x => { const c=findColumn(table,x.trim()); if(c){c.primary_key=true;c.indexed=true;c.nullable=false;} });
      continue;
    }
    if ((cm = clause.match(/^UNIQUE\s*\(([^)]+)\)/i))) {
      core.splitTopLevel(cm[1]).forEach(x => { const c=findColumn(table,x.trim()); if(c)c.indexed=true; });
      continue;
    }
    if ((cm = clause.match(/^FOREIGN\s+KEY\s*\(([^)]+)\)\s+REFERENCES\s+([^\s(]+)\s*\(([^)]+)\)/i))) {
      const locals=core.splitTopLevel(cm[1]);
      const remotes=core.splitTopLevel(cm[3]);
      locals.forEach((x,i)=>{const c=findColumn(table,x.trim());if(c)c.references={table:String(cm[2]).replace(/^[`"\[]|[`"\]]$/g,'').split('.').pop(),column:String(remotes[i]||remotes[0]||'').trim().replace(/^[`"\[]|[`"\]]$/g,'')};});
    }
  }
}

function normalizePrimaryKeyNullability(parsed) {
  for (const table of parsed) for (const col of table.columns) if (col.primary_key) col.nullable = false;
}

function parseMySqlDdl(sql) {
  const parsed = core.parseCreateTables(sql);
  markIndexColumns(parsed, sql);
  applyAlterTableConstraints(parsed, sql);
  normalizePrimaryKeyNullability(parsed);
  return parsed;
}

function parseOracleDdl(sql) {
  // Oracle dump tools often emit named inline constraints after the datatype,
  // e.g. VARCHAR2(25) CONSTRAINT EMP_NAME_NN NOT NULL. Normalize only the
  // constraint name token; the semantic keyword remains for the common parser.
  const normalized = sql.replace(/\bCONSTRAINT\s+(?:"[^"]+"|[\w$#]+)\s+(?=NOT\s+NULL|PRIMARY\s+KEY|UNIQUE\b|REFERENCES\b|CHECK\b)/ig, '');
  const parsed = core.parseCreateTables(normalized);

  // Oracle commonly stores comments outside CREATE TABLE.
  const commentRe = /COMMENT\s+ON\s+COLUMN\s+((?:"[^"]+"|[\w$#]+)\.)?("[^"]+"|[\w$#]+)\.("[^"]+"|[\w$#]+)\s+IS\s+'((?:''|[^'])*)'\s*;/ig;
  let m;
  while ((m = commentRe.exec(sql))) {
    const table = findParsedTable(parsed, m[2]);
    const col = findColumn(table, m[3]);
    if (col) col.ddl_comment = m[4].replace(/''/g, "'");
  }

  // Oracle PK/FK/UNIQUE are frequently emitted as ALTER TABLE statements;
  // indexes are also commonly emitted separately.
  applyAlterTableConstraints(parsed, sql);
  markIndexColumns(parsed, sql);

  // Identity columns are implicitly NOT NULL in Oracle.
  const createRe = /CREATE\s+TABLE\s+((?:"[^"]+"|[\w$#]+\.)?(?:"[^"]+"|[\w$#]+))\s*\(([\s\S]*?)\)\s*(?:TABLESPACE\b[\s\S]*?)?;/ig;
  while ((m = createRe.exec(sql))) {
    const table = findParsedTable(parsed, m[1]);
    if (!table) continue;
    for (const part of core.splitTopLevel(m[2])) {
      if (!/GENERATED\s+(?:ALWAYS|BY\s+DEFAULT(?:\s+ON\s+NULL)?)\s+AS\s+IDENTITY/i.test(part)) continue;
      const nm = part.trim().match(/^("[^"]+"|[\w$#]+)/);
      const col = nm ? findColumn(table, nm[1]) : null;
      if (col) { col.nullable = false; col.default_value = ''; }
    }
  }
  normalizePrimaryKeyNullability(parsed);
  return parsed;
}

const DDL_DIALECTS = {
  mysql: {
    id: 'mysql',
    label: 'MySQL',
    description: 'CREATE TABLE、内联 COMMENT、PK/KEY/INDEX、FOREIGN KEY、DEFAULT，以及独立 CREATE INDEX / ALTER TABLE 约束。',
    parse: parseMySqlDdl,
  },
  oracle: {
    id: 'oracle',
    label: 'Oracle',
    description: 'NUMBER/VARCHAR2/DATE 等列定义，COMMENT ON COLUMN、ALTER TABLE 约束、CREATE INDEX、IDENTITY。',
    parse: parseOracleDdl,
  },
};

function parseDdlWithDialect(sql, dialectId) {
  const adapter = DDL_DIALECTS[dialectId];
  if (!adapter) throw new Error(`不支持的数据库方言：${dialectId}`);
  return adapter.parse(sql);
}

// --- Schema Studio --------------------------------------------------------

class SchemaStudioModal extends Modal {
  constructor(app, plugin) {
    super(app); this.plugin=plugin; this.domain='api'; this.selectedKey=null; this.page='browse'; this.importState=null;
    this.pendingEdits=new Map(); this.gridSearch={api:'',db:''}; this.activeGridPopover=null; this.activeGridEditor=null;
    this._forceClosing=false; this._closePromptOpen=false;
    // Do not register another Escape handler here. Obsidian's Modal already owns
    // Escape. We override close() below so *every* close path (native Escape and
    // the title-bar X included) first yields to an active cell editor and then
    // passes through the same unsaved-change guard.
    this.scope?.register?.(null,'Enter',(evt)=>{
      if(evt?.__schemaStudioCellHandled)return false;
      if(this.activeGridEditor){
        if(evt)evt.__schemaStudioCellHandled=true;
        this.activeGridEditor.commit();
        return false;
      }
      return true;
    });
    this.scope?.register?.(['Mod'],'s',(evt)=>{
      evt?.preventDefault?.();
      if(this.activeGridEditor)this.activeGridEditor.commit();
      if(this.page==='browse'&&this.pendingEdits.size){this.saveAllPendingEdits({render:true,notify:true});return false;}
      return false;
    });
  }
  onOpen(){this.modalEl.addClass('schema-studio-modal');this.render();}
  getPendingEditStats(){
    let records=0,cells=0;
    for(const edits of this.pendingEdits.values()){const n=Object.keys(edits||{}).length;if(n){records++;cells+=n;}}
    return {records,cells};
  }
  hasPendingImport(){return (this.page==='json-diff'||this.page==='ddl-diff')&&!!this.importState?.analysis?.length;}
  hasUnsavedChanges(){const p=this.getPendingEditStats();return p.cells>0||this.hasPendingImport();}
  unsavedSummary(){
    const p=this.getPendingEditStats(),parts=[];
    if(p.cells)parts.push(`${p.records} 条记录共 ${p.cells} 处手工修改`);
    if(this.hasPendingImport())parts.push(this.page==='json-diff'?'JSON 导入对比尚未应用':'DDL 导入对比尚未应用');
    return parts.join('；')||'存在未保存修改';
  }
  close(){
    if(this._forceClosing)return super.close();
    // Native Modal Escape can fire before the editor DOM keydown. Treat the first
    // close request while a cell is active as "leave/cancel cell edit" only.
    if(this.activeGridEditor){this.activeGridEditor.cancel();return;}
    if(this.hasUnsavedChanges()){this.openUnsavedPrompt();return;}
    return super.close();
  }
  forceClose(){this._forceClosing=true;return super.close();}
  openUnsavedPrompt(){
    if(this._closePromptOpen)return;
    this._closePromptOpen=true;
    new SchemaStudioUnsavedModal(this.app,this).open();
  }
  async saveAllPendingEdits({render=true,notify=true}={}){
    let count=0;
    for(const [filePath,edits] of [...this.pendingEdits.entries()]){
      if(!edits||!Object.keys(edits).length){this.pendingEdits.delete(filePath);continue;}
      const file=this.app.vault.getAbstractFileByPath(filePath);
      if(!file)continue;
      await this.app.fileManager.processFrontMatter(file,fm=>{for(const[k,v]of Object.entries(edits))fm[k]=v;});
      this.pendingEdits.delete(filePath);count++;
    }
    if(notify)new Notice(count?`已保存 ${count} 条 Schema 记录`:'没有需要保存的修改');
    if(render)this.render();
    return count;
  }
  async saveDirtyAndClose(){
    try{
      // Apply import first, then manual pending edits. If an import analysis was
      // built from an older snapshot, the user's latest manual edits must win.
      if(this.page==='json-diff'&&this.importState?.analysis)await this.applyJson(this.importState);
      else if(this.page==='ddl-diff'&&this.importState?.analysis)await this.applyDdl(this.importState);
      await this.saveAllPendingEdits({render:false,notify:false});
      this.forceClose();
    }catch(error){console.error('[Schema Studio] 保存并关闭失败',error);new Notice(`保存失败：${error?.message||error}`);}
  }
  discardDirtyAndClose(){this.pendingEdits.clear();this.importState=null;this.forceClose();}
  render(){
    this.activeGridEditor=null;
    this.contentEl.empty(); const shell=this.contentEl.createDiv({cls:'schema-studio-shell'}); this.sidebarEl=shell.createDiv({cls:'schema-studio-sidebar'}); this.mainEl=shell.createDiv({cls:'schema-studio-main'}); this.renderSidebar();
    if(this.page==='json-import')this.renderJsonImport(); else if(this.page==='json-diff')this.renderJsonDiff(); else if(this.page==='ddl-import')this.renderDdlImport(); else if(this.page==='ddl-diff')this.renderDdlDiff(); else this.renderBrowse();
  }
  renderSidebar(){
    const title=this.sidebarEl.createDiv({cls:'schema-studio-brand'});title.createDiv({text:'Schema Studio',cls:'schema-studio-brand-title'});title.createDiv({text:'接口 / 数据库结构管理',cls:'schema-tools-muted'});
    const tabs=this.sidebarEl.createDiv({cls:'schema-studio-domain-tabs'});this.domainButton(tabs,'api','接口');this.domainButton(tabs,'db','数据库');
    const importBtn=this.sidebarEl.createEl('button',{text:this.domain==='api'?'+ 导入 / 新建接口':'+ 批量导入 / 更新 DDL',cls:'schema-studio-import-button mod-cta'});importBtn.onclick=()=>{this.page=this.domain==='api'?'json-import':'ddl-import';this.importState=null;this.render();};
    const search=this.sidebarEl.createEl('input',{type:'search',placeholder:'筛选…',cls:'schema-studio-nav-search'});const list=this.sidebarEl.createDiv({cls:'schema-studio-nav-list'});
    const draw=()=>{list.empty();const q=search.value.trim().toLowerCase();const items=this.domain==='api'?this.getApiGroups():this.getDbGroups();items.filter(x=>!q||x.label.toLowerCase().includes(q)).forEach(item=>{const row=list.createDiv({cls:`schema-studio-nav-item${this.selectedKey===item.key&&this.page==='browse'?' is-active':''}`});row.createDiv({text:item.label,cls:'schema-studio-nav-title'});row.createDiv({text:item.detail,cls:'schema-tools-muted'});row.onclick=()=>{this.selectedKey=item.key;this.page='browse';this.render();};});if(!items.length)list.createDiv({text:'暂无数据',cls:'schema-tools-muted schema-studio-empty'});};search.oninput=draw;draw();
  }
  domainButton(parent,domain,label){const btn=parent.createEl('button',{text:label,cls:this.domain===domain?'is-active':''});btn.onclick=()=>{this.domain=domain;this.selectedKey=null;this.page='browse';this.importState=null;this.render();};}
  getApiGroups(){const map=new Map();for(const r of this.plugin.scanApiFields()){if(!map.has(r.apiName))map.set(r.apiName,{key:r.apiName,label:r.apiName,rows:[],apiPath:r.apiPath});map.get(r.apiName).rows.push(r);}return [...map.values()].sort((a,b)=>a.label.localeCompare(b.label,'zh-CN')).map(x=>({...x,detail:`${x.rows.filter(r=>!r.schema_orphaned).length} 个节点`}));}
  getDbGroups(){const map=new Map();for(const r of this.plugin.scanDbColumns()){if(!map.has(r.table))map.set(r.table,{key:r.table,label:r.table,rows:[],tablePath:r.tablePath});map.get(r.table).rows.push(r);}return [...map.values()].sort((a,b)=>a.label.localeCompare(b.label)).map(x=>({...x,detail:`${x.rows.filter(r=>!r.schema_orphaned).length} 列`}));}
  renderBrowse(){this.domain==='api'?this.renderApiBrowse():this.renderDbBrowse();}
  renderWelcome(title,text){this.mainEl.createDiv({text:title,cls:'schema-studio-welcome-title'});this.mainEl.createDiv({text,cls:'schema-tools-muted schema-studio-welcome-text'});}

  renderHeader(title,subtitle,buttons=[]){
    const header=this.mainEl.createDiv({cls:'schema-studio-main-header'});const left=header.createDiv();left.createEl('h2',{text:title});if(subtitle)left.createDiv({text:subtitle,cls:'schema-tools-muted'});const actions=header.createDiv({cls:'schema-studio-header-actions'});for(const b of buttons){const btn=actions.createEl('button',{text:b.text,cls:b.primary?'mod-cta':''});btn.onclick=b.onclick;}return header;
  }
  getGridDefinitions(domain,extraKeys=[]){
    const schema=this.plugin.getFieldDefinitions(domain);
    const hidden=new Set(['api','table','schema_orphaned','schema_source','schema_dialect','last_imported_at']);
    const defs=schema.fields.filter(d=>!hidden.has(d.name));
    const by=new Map(defs.map(d=>[d.name,d]));
    for(const key of extraKeys||[])if(key&&!hidden.has(key)&&!by.has(key)){
      const d={name:key,type:key==='order'?'Number':['nullable','primary_key','indexed'].includes(key)?'Boolean':'Input',required:false,options:[]};
      by.set(key,d);defs.push(d);
    }
    return {schema,defs};
  }
  getGridViewPrefs(domain){
    const root=this.plugin.settings.gridViewPrefs||(this.plugin.settings.gridViewPrefs={});
    const cur=root[domain]||(root[domain]={hiddenProps:[],sorts:[],filters:[]});
    if(!Array.isArray(cur.hiddenProps))cur.hiddenProps=[];
    if(!Array.isArray(cur.sorts))cur.sorts=[];
    if(!Array.isArray(cur.filters))cur.filters=[];
    return cur;
  }
  persistGridViewPrefs(){ this.plugin.saveSettings().catch(e=>console.warn('[Schema Studio] 保存视图设置失败',e)); }
  toolbarButton(parent,icon,label,onClick,active=false){
    const btn=parent.createEl('button',{cls:`schema-studio-view-tool${active?' is-active':''}`,attr:{type:'button','aria-label':label}});
    const ico=btn.createSpan({cls:'schema-studio-view-tool-icon'});try{setIcon(ico,icon);}catch(_e){}
    btn.createSpan({text:label,cls:'schema-studio-view-tool-label'});btn.onclick=(e)=>{e.preventDefault();e.stopPropagation();onClick(btn,e);};return btn;
  }
  closeGridPopover(){ if(this.activeGridPopover){this.activeGridPopover.remove();this.activeGridPopover=null;} }
  openGridPopover(toolbar,button,title,build){
    if(this.activeGridPopover){const same=this.activeGridPopover.dataset.owner===button.dataset.toolOwner;this.closeGridPopover();if(same)return;}
    if(!button.dataset.toolOwner)button.dataset.toolOwner=`tool-${Date.now()}-${Math.random()}`;
    const pop=toolbar.createDiv({cls:'schema-studio-view-popover'});pop.dataset.owner=button.dataset.toolOwner;
    const head=pop.createDiv({cls:'schema-studio-view-popover-head'});head.createDiv({text:title,cls:'schema-studio-view-popover-title'});
    const close=head.createEl('button',{cls:'schema-studio-view-popover-close',attr:{type:'button','aria-label':'关闭'}});try{setIcon(close,'x');}catch(_e){}close.onclick=()=>this.closeGridPopover();
    build(pop);this.activeGridPopover=pop;
  }
  compareGridValues(a,b){
    if(a==null&&b==null)return 0;if(a==null)return -1;if(b==null)return 1;
    if(typeof a==='number'&&typeof b==='number')return a-b;
    if(typeof a==='boolean'&&typeof b==='boolean')return Number(a)-Number(b);
    return String(a).localeCompare(String(b),'zh-CN',{numeric:true,sensitivity:'base'});
  }
  gridModelMatchesFilter(model,rule){
    const v=model.getValue(rule.field);const text=displayGridValue(v).toLowerCase();const q=String(rule.value??'').toLowerCase();
    if(rule.op==='eq')return text===q;if(rule.op==='neq')return text!==q;if(rule.op==='empty')return text==='';if(rule.op==='notEmpty')return text!=='';
    if(rule.op==='starts')return text.startsWith(q);return text.includes(q);
  }
  renderGridToolbar(rows,models,defs,domain,gridHost,draw){
    const prefs=this.getGridViewPrefs(domain);const toolbar=this.mainEl.createDiv({cls:'schema-studio-view-toolbar'});
    const left=toolbar.createDiv({cls:'schema-studio-view-toolbar-left'});const vi=left.createSpan({cls:'schema-studio-view-icon'});try{setIcon(vi,'table-properties');}catch(_e){}
    left.createSpan({text:domain==='api'?'当前接口字段':'当前数据表字段',cls:'schema-studio-view-name'});const count=left.createSpan({cls:'schema-studio-view-count'});
    const right=toolbar.createDiv({cls:'schema-studio-view-toolbar-right'});
    const updateCount=(n)=>count.setText(`${n} 个结果`);
    const sortBtn=this.toolbarButton(right,'arrow-up-down','排序',(btn)=>this.openGridPopover(toolbar,btn,'排序',(pop)=>{
      const list=pop.createDiv({cls:'schema-studio-rule-list'});
      const redrawRules=()=>{list.empty();prefs.sorts.forEach((rule,i)=>{
        const row=list.createDiv({cls:'schema-studio-rule-row'});const sel=row.createEl('select');defs.forEach(d=>sel.createEl('option',{value:d.name,text:d.name}));sel.value=rule.field||defs[0]?.name||'';
        const dir=row.createEl('select');dir.createEl('option',{value:'asc',text:'升序'});dir.createEl('option',{value:'desc',text:'降序'});dir.value=rule.dir||'asc';
        const del=row.createEl('button',{text:'×',attr:{type:'button','aria-label':'移除排序'}});
        sel.onchange=()=>{rule.field=sel.value;this.persistGridViewPrefs();draw();};dir.onchange=()=>{rule.dir=dir.value;this.persistGridViewPrefs();draw();};del.onclick=()=>{prefs.sorts.splice(i,1);this.persistGridViewPrefs();redrawRules();draw();};
      });if(!prefs.sorts.length)list.createDiv({text:'未设置排序',cls:'schema-tools-muted'});};redrawRules();
      const actions=pop.createDiv({cls:'schema-studio-popover-actions'});const add=actions.createEl('button',{text:'+ 添加排序'});add.onclick=()=>{prefs.sorts.push({field:defs[0]?.name||'',dir:'asc'});this.persistGridViewPrefs();redrawRules();draw();};const clear=actions.createEl('button',{text:'清除'});clear.onclick=()=>{prefs.sorts=[];this.persistGridViewPrefs();redrawRules();draw();};
    }),prefs.sorts.length>0);
    const filterBtn=this.toolbarButton(right,'filter','筛选',(btn)=>this.openGridPopover(toolbar,btn,'筛选（全部条件同时满足）',(pop)=>{
      const list=pop.createDiv({cls:'schema-studio-rule-list'});
      const redrawRules=()=>{list.empty();prefs.filters.forEach((rule,i)=>{
        const row=list.createDiv({cls:'schema-studio-rule-row schema-studio-filter-rule'});const sel=row.createEl('select');defs.forEach(d=>sel.createEl('option',{value:d.name,text:d.name}));sel.value=rule.field||defs[0]?.name||'';
        const op=row.createEl('select');[['contains','包含'],['eq','等于'],['neq','不等于'],['starts','开头是'],['empty','为空'],['notEmpty','不为空']].forEach(([v,t])=>op.createEl('option',{value:v,text:t}));op.value=rule.op||'contains';
        const value=row.createEl('input',{type:'text',placeholder:'值'});value.value=rule.value||'';value.toggleClass('is-hidden',['empty','notEmpty'].includes(op.value));
        const del=row.createEl('button',{text:'×',attr:{type:'button','aria-label':'移除筛选'}});
        sel.onchange=()=>{rule.field=sel.value;this.persistGridViewPrefs();draw();};op.onchange=()=>{rule.op=op.value;value.toggleClass('is-hidden',['empty','notEmpty'].includes(op.value));this.persistGridViewPrefs();draw();};value.oninput=()=>{rule.value=value.value;this.persistGridViewPrefs();draw();};del.onclick=()=>{prefs.filters.splice(i,1);this.persistGridViewPrefs();redrawRules();draw();};
      });if(!prefs.filters.length)list.createDiv({text:'未设置筛选',cls:'schema-tools-muted'});};redrawRules();
      const actions=pop.createDiv({cls:'schema-studio-popover-actions'});const add=actions.createEl('button',{text:'+ 添加筛选'});add.onclick=()=>{prefs.filters.push({field:defs[0]?.name||'',op:'contains',value:''});this.persistGridViewPrefs();redrawRules();draw();};const clear=actions.createEl('button',{text:'清除'});clear.onclick=()=>{prefs.filters=[];this.persistGridViewPrefs();redrawRules();draw();};
    }),prefs.filters.length>0);
    const propBtn=this.toolbarButton(right,'list','属性',(btn)=>this.openGridPopover(toolbar,btn,'显示属性',(pop)=>{
      const hidden=new Set(prefs.hiddenProps);const list=pop.createDiv({cls:'schema-studio-property-list'});
      defs.forEach(def=>{const label=list.createEl('label',{cls:'schema-studio-property-row'});const cb=label.createEl('input',{type:'checkbox'});cb.checked=!hidden.has(def.name);label.createSpan({text:def.name});cb.onchange=()=>{const set=new Set(prefs.hiddenProps);if(cb.checked)set.delete(def.name);else set.add(def.name);if(set.size>=defs.length){cb.checked=true;new Notice('至少保留一个属性列');return;}prefs.hiddenProps=[...set];this.persistGridViewPrefs();draw();};});
      const actions=pop.createDiv({cls:'schema-studio-popover-actions'});const all=actions.createEl('button',{text:'全部显示'});all.onclick=()=>{prefs.hiddenProps=[];this.persistGridViewPrefs();this.closeGridPopover();draw();};
    }),prefs.hiddenProps.length>0);
    let searchInput=null;
    const searchBtn=this.toolbarButton(right,'search','搜索',(_btn)=>{
      if(searchInput){searchInput.remove();searchInput=null;this.gridSearch[domain]='';draw();return;}
      searchInput=right.createEl('input',{type:'search',placeholder:'搜索当前表…',cls:'schema-studio-view-search'});searchInput.value=this.gridSearch[domain]||'';searchInput.oninput=()=>{this.gridSearch[domain]=searchInput.value;draw();};searchInput.onkeydown=(e)=>{if(e.key==='Escape'){e.preventDefault();searchInput.remove();searchInput=null;this.gridSearch[domain]='';draw();}};searchInput.focus();
    },!!this.gridSearch[domain]);
    this.toolbarButton(right,'plus','新建',(btn)=>this.openNewRecordPopover(toolbar,btn,domain,rows));
    return {toolbar,count,updateCount};
  }
  async createManualRecord(domain,rows,values){
    if(domain==='api'){
      const apiName=this.selectedKey;const direction=String(values.direction||'Request');const path=String(values.path||'').trim();if(!path){new Notice('请输入字段 path');return;}
      if(rows.some(r=>r.direction===direction&&r.path===path)){new Notice(`${direction} / ${path} 已存在`);return;}
      const group=this.getApiGroups().find(x=>x.key===apiName);const apiDocPath=normalizePath(group?.apiPath||`${this.plugin.settings.apiDocsFolder}/${apiName}.md`);await ensureFolder(this.app,this.plugin.settings.apiFieldsFolder);await ensureFolder(this.app,this.plugin.settings.apiDocsFolder);
      if(!this.app.vault.getAbstractFileByPath(apiDocPath))await this.app.vault.create(apiDocPath,`# ${apiName}\n\n## Request\n\n![[${this.plugin.settings.apiBaseName}#当前接口 Request]]\n\n## Response\n\n![[${this.plugin.settings.apiBaseName}#当前接口 Response]]\n`);
      const parentRaw=path.includes('.')?path.slice(0,path.lastIndexOf('.')):'';const parent=parentRaw.replace(/\[\]$/,'');const leaf=(path.includes('.')?path.slice(path.lastIndexOf('.')+1):path).replace(/\[\]$/,'');
      const props=this.plugin.defaultPropertiesForDomain('api');const nextOrder=Math.max(0,...rows.filter(r=>r.direction===direction).map(r=>Number(r.order||0)))+10;Object.assign(props,{api:`[[${apiDocPath.replace(/\.md$/,'')}]]`,direction,path,parent_path:parent,name:leaf,shape:values.shape||'Scalar',data_type:values.data_type||'string',order:nextOrder,schema_source:'manual',schema_orphaned:false});
      const filePath=normalizePath(`${this.plugin.settings.apiFieldsFolder}/${core.makeApiFieldFilename(apiName,direction,path)}.md`);if(this.app.vault.getAbstractFileByPath(filePath)){new Notice(`目标文件已存在：${filePath}`);return;}await this.app.vault.create(filePath,`---\n${stringifyYaml(props)}---\n\n${noteBodyApiField(apiName,direction,props)}`);new Notice(`已新建 ${direction} / ${path}`);
    }else{
      const table=this.selectedKey;const name=String(values.name||'').trim();if(!name){new Notice('请输入列名');return;}if(rows.some(r=>r.name===name)){new Notice(`${name} 已存在`);return;}
      const group=this.getDbGroups().find(x=>x.key===table);const tableDocPath=normalizePath(group?.tablePath||`${this.plugin.settings.dbDocsFolder}/${table}.md`);await ensureFolder(this.app,this.plugin.settings.dbColumnsFolder);await ensureFolder(this.app,this.plugin.settings.dbDocsFolder);if(!this.app.vault.getAbstractFileByPath(tableDocPath))await this.app.vault.create(tableDocPath,`# ${table}\n\n## 字段\n\n![[${this.plugin.settings.dbBaseName}#当前数据表]]\n`);
      const props=this.plugin.defaultPropertiesForDomain('db');const nextOrder=Math.max(0,...rows.map(r=>Number(r.order||0)))+10;Object.assign(props,{table:`[[${tableDocPath.replace(/\.md$/,'')}]]`,name,data_type:values.data_type||'VARCHAR(255)',nullable:true,primary_key:false,indexed:false,order:nextOrder,schema_source:'manual',schema_orphaned:false});
      const filePath=normalizePath(`${this.plugin.settings.dbColumnsFolder}/${core.makeDbColumnFilename(table,name)}.md`);if(this.app.vault.getAbstractFileByPath(filePath)){new Notice(`目标文件已存在：${filePath}`);return;}await this.app.vault.create(filePath,`---\n${stringifyYaml(props)}---\n\n${noteBodyDbColumn(table,props)}`);new Notice(`已新建 ${table}.${name}`);
    }
    this.closeGridPopover();this.render();
  }
  openNewRecordPopover(toolbar,button,domain,rows){
    this.openGridPopover(toolbar,button,domain==='api'?'新建接口字段':'新建数据库列',(pop)=>{
      const form=pop.createDiv({cls:'schema-studio-new-form'});const values={};
      if(domain==='api'){
        const lab1=form.createEl('label');lab1.createSpan({text:'方向'});const dir=lab1.createEl('select');dir.createEl('option',{value:'Request',text:'Request'});dir.createEl('option',{value:'Response',text:'Response'});dir.onchange=()=>values.direction=dir.value;values.direction='Request';
        const lab2=form.createEl('label');lab2.createSpan({text:'path'});const path=lab2.createEl('input',{type:'text',placeholder:'items[].sku_id'});path.oninput=()=>values.path=path.value;
        const lab3=form.createEl('label');lab3.createSpan({text:'shape'});const shape=lab3.createEl('select');['Scalar','Object','List','List<Object>'].forEach(x=>shape.createEl('option',{value:x,text:x}));shape.onchange=()=>values.shape=shape.value;values.shape='Scalar';
        const lab4=form.createEl('label');lab4.createSpan({text:'data_type'});const dt=lab4.createEl('input',{type:'text',placeholder:'string'});dt.value='string';dt.oninput=()=>values.data_type=dt.value;values.data_type='string';
      }else{
        const lab1=form.createEl('label');lab1.createSpan({text:'列名'});const name=lab1.createEl('input',{type:'text',placeholder:'column_name'});name.oninput=()=>values.name=name.value;
        const lab2=form.createEl('label');lab2.createSpan({text:'data_type'});const dt=lab2.createEl('input',{type:'text',placeholder:'VARCHAR(255)'});dt.value='VARCHAR(255)';dt.oninput=()=>values.data_type=dt.value;values.data_type='VARCHAR(255)';
      }
      const actions=pop.createDiv({cls:'schema-studio-popover-actions'});const create=actions.createEl('button',{text:'创建',cls:'mod-cta'});create.onclick=()=>this.createManualRecord(domain,rows,values);
    });
  }

  renderGenericEditor(rows,domain){
    const {schema,defs}=this.getGridDefinitions(domain);const prefs=this.getGridViewPrefs(domain);
    const models=rows.map(row=>({
      key:domain==='api'?row.path:row.name,source:row,
      getValue:(name)=>{const pending=this.pendingEdits.get(row.file.path);return pending&&Object.prototype.hasOwnProperty.call(pending,name)?pending[name]:row.fm?.[name];},
      getBefore:(name)=>row.fm?.[name],
      setValue:(name,value)=>{let pending=this.pendingEdits.get(row.file.path)||{};if(valuesEqual(row.fm?.[name],value))delete pending[name];else pending[name]=value;if(Object.keys(pending).length)this.pendingEdits.set(row.file.path,pending);else this.pendingEdits.delete(row.file.path);},
      readonly:(name)=>NON_EDITABLE_IDENTITY_KEYS.has(name),status:'normal'
    }));
    const gridHost=this.mainEl.createDiv({cls:'schema-studio-grid-host'});let toolbarCtl=null;
    const draw=()=>{
      const hidden=new Set(prefs.hiddenProps||[]);let visibleDefs=defs.filter(d=>!hidden.has(d.name));if(!visibleDefs.length)visibleDefs=defs.slice(0,1);
      let visible=models.slice();const q=String(this.gridSearch[domain]||'').trim().toLowerCase();if(q)visible=visible.filter(m=>defs.some(d=>displayGridValue(m.getValue(d.name)).toLowerCase().includes(q)));
      for(const rule of prefs.filters||[])visible=visible.filter(m=>this.gridModelMatchesFilter(m,rule));
      if((prefs.sorts||[]).length)visible.sort((a,b)=>{for(const rule of prefs.sorts){const c=this.compareGridValues(a.getValue(rule.field),b.getValue(rule.field));if(c)return rule.dir==='desc'?-c:c;}return 0;});
      gridHost.empty();this.renderDataGrid(visible,visibleDefs,{domain,editable:true,parentEl:gridHost});toolbarCtl?.updateCount(visible.length);
    };
    toolbarCtl=this.renderGridToolbar(rows,models,defs,domain,gridHost,draw);this.mainEl.insertBefore(toolbarCtl.toolbar,gridHost);draw();return schema;
  }
  renderDataGrid(models,defs,options={}){
    const parentEl=options.parentEl||this.mainEl;
    const wrap=parentEl.createDiv({cls:'schema-studio-grid-wrap'});
    wrap.tabIndex=0;
    const table=wrap.createEl('table',{cls:'schema-studio-grid'});
    const thead=table.createEl('thead'),hr=thead.createEl('tr');
    if(options.showStatus)hr.createEl('th',{text:'',cls:'schema-studio-grid-status-head'});
    for(const def of defs){const th=hr.createEl('th');th.createSpan({text:def.name});}
    const body=table.createEl('tbody');
    const state={anchor:null,focus:null,cells:[],editing:null,mouseDown:false,mouseMoved:false,mouseWasFocused:false};
    const cellAt=(r,c)=>state.cells.find(x=>x.r===r&&x.c===c);
    const refreshSelection=()=>{
      const a=state.anchor,f=state.focus;
      for(const cell of state.cells)cell.td.removeClass('is-selected','is-selection-edge');
      if(!a||!f)return;
      const r1=Math.min(a.r,f.r),r2=Math.max(a.r,f.r),c1=Math.min(a.c,f.c),c2=Math.max(a.c,f.c);
      for(const cell of state.cells)if(cell.r>=r1&&cell.r<=r2&&cell.c>=c1&&cell.c<=c2){
        cell.td.addClass('is-selected');
        if(cell.r===r1||cell.r===r2||cell.c===c1||cell.c===c2)cell.td.addClass('is-selection-edge');
      }
    };
    const selectCell=(r,c,extend=false,ensureVisible=true)=>{
      if(!extend||!state.anchor)state.anchor={r,c};
      state.focus={r,c};refreshSelection();
      const cell=cellAt(r,c);if(cell){cell.td.focus({preventScroll:true});if(ensureVisible)cell.td.scrollIntoView?.({block:'nearest',inline:'nearest'});}
    };
    const getRange=()=>{
      if(!state.anchor||!state.focus)return null;
      return {r1:Math.min(state.anchor.r,state.focus.r),r2:Math.max(state.anchor.r,state.focus.r),c1:Math.min(state.anchor.c,state.focus.c),c2:Math.max(state.anchor.c,state.focus.c)};
    };
    const renderCell=(cell)=>{
      const {td,model,def}=cell;td.empty();
      const value=model.getValue(def.name),before=model.getBefore?model.getBefore(def.name):undefined;
      const changed=!!model.getBefore&&!valuesEqual(before,value);
      const removed=model.status==='removed';
      td.toggleClass('is-readonly',!!model.readonly?.(def.name));
      td.toggleClass('has-diff',changed);
      td.toggleClass('is-removed-cell',removed);
      if(changed){
        td.createEl('del',{text:displayGridValue(before)||'（空）',cls:'schema-studio-grid-old'});
        td.createSpan({text:displayGridValue(value)||'（空）',cls:'schema-studio-grid-new'});
      }else if(removed){
        td.createEl('del',{text:displayGridValue(before!==undefined?before:value)||'（空）',cls:'schema-studio-grid-old'});
      }else{
        const s=td.createSpan({text:displayGridValue(value),cls:'schema-studio-grid-value'});
        if(displayGridValue(value)==='')s.addClass('is-empty');
      }
    };
    const finishEditor=(cell,input,{cancel=false,focusCell=true}={})=>{
      if(!cell||!input)return;
      // Detach blur first. Otherwise Escape -> focus(cell) can blur the editor and
      // accidentally commit the value we are trying to cancel.
      input.onblur=null;
      if(!cancel){
        let v;
        if(input.tagName==='SELECT')v=input.value;
        else if(input.type==='checkbox')v=input.checked;
        else v=clipboardValueForType(input.value,cell.def);
        cell.model.setValue(cell.def.name,v);
      }
      if(state.editing?.input===input)state.editing=null;
      if(this.activeGridEditor?.input===input)this.activeGridEditor=null;
      cell.td.removeClass('is-editing');
      renderCell(cell);
      if(focusCell)cell.td.focus({preventScroll:true});
    };
    const commitEditor=(cell,input,focusCell=true)=>finishEditor(cell,input,{cancel:false,focusCell});
    const cancelEditor=(cell,input,focusCell=true)=>finishEditor(cell,input,{cancel:true,focusCell});
    const beginEdit=(cell,initial,caretClientX)=>{
      if(!options.editable||cell.model.status==='removed'||cell.model.readonly?.(cell.def.name))return;
      if(state.editing?.cell===cell)return;
      if(state.editing&&state.editing.cell!==cell)commitEditor(state.editing.cell,state.editing.input);
      const type=String(cell.def.type||'Input').toLowerCase(),cur=cell.model.getValue(cell.def.name);
      cell.td.empty();cell.td.addClass('is-editing');
      let input;
      if(type==='boolean'){
        cell.model.setValue(cell.def.name,!Boolean(cur));
        renderCell(cell);
        cell.td.focus();
        return;
      }else if(type==='select'&&cell.def.options?.length){
        input=cell.td.createEl('select');for(const x of cell.def.options)input.createEl('option',{value:String(x),text:String(x)});input.value=cur==null?'':String(cur);
      }else{
        input=cell.td.createEl('input',{type:type==='number'?'number':'text',cls:'schema-studio-grid-editor'});
        input.value=initial!==undefined?String(initial):displayGridValue(cur);
        const placeCaret=()=>{
          if(!input.setSelectionRange)return;
          if(initial!==undefined){const n=String(initial).length;input.setSelectionRange(n,n);return;}
          const text=input.value||'';if(caretClientX==null){input.setSelectionRange(text.length,text.length);return;}
          const rect=input.getBoundingClientRect(),style=getComputedStyle(input),pad=parseFloat(style.paddingLeft)||0,x=Math.max(0,caretClientX-rect.left-pad+(input.scrollLeft||0));
          const canvas=beginEdit._canvas||(beginEdit._canvas=document.createElement('canvas'));const ctx=canvas.getContext('2d');if(!ctx){input.setSelectionRange(text.length,text.length);return;}ctx.font=`${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;let lo=0,hi=text.length;while(lo<hi){const mid=Math.ceil((lo+hi)/2);if(ctx.measureText(text.slice(0,mid)).width<=x)lo=mid;else hi=mid-1;}input.setSelectionRange(lo,lo);
        };
        requestAnimationFrame(placeCaret);
      }
      state.editing={cell,input};
      this.activeGridEditor={
        input,
        commit:()=>commitEditor(cell,input,true),
        cancel:()=>cancelEditor(cell,input,true),
      };
      input.focus();
      input.onblur=()=>commitEditor(cell,input,false);
      const handleEditorKeydown=(e)=>{
        if(e.key==='Enter'){
          e.__schemaStudioCellHandled=true;
          e.preventDefault();e.stopPropagation();e.stopImmediatePropagation?.();
          commitEditor(cell,input,true);
          return;
        }
        if(e.key==='Escape'){
          e.__schemaStudioCellHandled=true;
          e.preventDefault();e.stopPropagation();e.stopImmediatePropagation?.();
          cancelEditor(cell,input,true);
          return;
        }
        if(e.key==='Tab'){
          e.__schemaStudioCellHandled=true;
          e.preventDefault();e.stopPropagation();e.stopImmediatePropagation?.();
          commitEditor(cell,input,false);
          const nc=Math.max(0,Math.min(defs.length-1,cell.c+(e.shiftKey?-1:1)));
          selectCell(cell.r,nc);
        }
      };
      // Capture on the editor itself so Enter/Escape are consumed before they
      // can bubble into Obsidian's Modal/Scope keyboard handlers.
      input.addEventListener('keydown',handleEditorKeydown,true);
    };
    const copySelection=(e)=>{
      const rg=getRange();if(!rg)return;
      const lines=[];
      for(let r=rg.r1;r<=rg.r2;r++){const vals=[];for(let c=rg.c1;c<=rg.c2;c++){const cell=cellAt(r,c);vals.push(displayGridValue(cell?.model.getValue(cell.def.name)));}lines.push(vals.join('\t'));}
      e.clipboardData?.setData('text/plain',lines.join('\n'));e.preventDefault();
    };
    const pasteSelection=(e)=>{
      if(!options.editable||!state.focus)return;
      const raw=e.clipboardData?.getData('text/plain');if(raw==null)return;
      const matrix=parseClipboardTable(raw);if(!matrix.length)return;
      e.preventDefault();
      let headerMap=null,startRow=0;
      const headerMatches=matrix[0].map(v=>defs.findIndex(d=>d.name===String(v).trim()));
      if(headerMatches.filter(i=>i>=0).length>=2){headerMap=headerMatches;startRow=1;}
      let changed=0,skipped=0;
      for(let sr=startRow;sr<matrix.length;sr++){
        const tr=state.focus.r+(sr-startRow);if(tr>=models.length){skipped+=matrix[sr].length;continue;}
        for(let sc=0;sc<matrix[sr].length;sc++){
          const tc=headerMap?(headerMap[sc]??-1):(state.focus.c+sc);if(tc<0||tc>=defs.length){skipped++;continue;}
          const cell=cellAt(tr,tc);if(!cell||cell.model.status==='removed'||cell.model.readonly?.(cell.def.name)){skipped++;continue;}
          cell.model.setValue(cell.def.name,clipboardValueForType(matrix[sr][sc],cell.def));renderCell(cell);changed++;
        }
      }
      if(changed)new Notice(`已粘贴 ${changed} 个单元格${skipped?`，跳过 ${skipped} 个不可写/越界单元格`:''}`);
    };
    models.forEach((model,r)=>{
      const tr=body.createEl('tr',{cls:`schema-studio-grid-row schema-grid-row-${model.status||'normal'}`});
      if(options.showStatus){const s=tr.createEl('td',{cls:'schema-studio-grid-status'});s.setText(model.status==='added'?'+':model.status==='removed'?'−':model.status==='changed'?'~':'');s.setAttr('title',model.status==='added'?'新增':model.status==='removed'?'源中消失':model.status==='changed'?'有变化':'未变化');}
      defs.forEach((def,c)=>{
        const td=tr.createEl('td',{cls:'schema-studio-grid-cell',attr:{tabindex:'0'}});
        const cell={r,c,td,model,def};state.cells.push(cell);renderCell(cell);
        if(model.readonly?.(def.name)){td.setAttr('title',`${def.name}：结构标识字段，只读`);td.setAttr('aria-readonly','true');}
        td.onmousedown=(e)=>{
          if(e.button!==0)return;
          if(e.target instanceof HTMLInputElement||e.target instanceof HTMLSelectElement||e.target instanceof HTMLTextAreaElement)return;
          state.mouseWasFocused=!!state.focus&&state.focus.r===r&&state.focus.c===c;
          state.mouseMoved=false;state.mouseDown=true;selectCell(r,c,e.shiftKey);
        };
        td.onmouseenter=()=>{if(state.mouseDown){state.mouseMoved=true;state.focus={r,c};refreshSelection();}};
        td.onmouseup=()=>state.mouseDown=false;
        td.onclick=(e)=>{
          if(e.target instanceof HTMLInputElement||e.target instanceof HTMLSelectElement||e.target instanceof HTMLTextAreaElement)return;
          const isBoolean=String(cell.def.type||'').toLowerCase()==='boolean';
          if(!isBoolean&&state.mouseWasFocused&&!state.mouseMoved&&!e.shiftKey&&!e.metaKey&&!e.ctrlKey)beginEdit(cell,undefined,e.clientX);
        };
        td.ondblclick=(e)=>{
          e.preventDefault();
          beginEdit(cell,undefined,e.clientX);
        };
        td.onkeydown=(e)=>{
          if(state.editing)return;
          if(e.key==='Enter'||e.key==='F2'||(e.key===' '&&String(cell.def.type||'').toLowerCase()==='boolean')){e.preventDefault();beginEdit(cell);return;}
          if((e.key==='Delete'||e.key==='Backspace')&&options.editable){e.preventDefault();const rg=getRange();if(!rg)return;for(const cc of state.cells)if(cc.r>=rg.r1&&cc.r<=rg.r2&&cc.c>=rg.c1&&cc.c<=rg.c2&&!cc.model.readonly?.(cc.def.name)&&cc.model.status!=='removed'){cc.model.setValue(cc.def.name,clipboardValueForType('',cc.def));renderCell(cc);}return;}
          if((e.ctrlKey||e.metaKey)&&['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key)){
            e.preventDefault();const dx=e.key==='ArrowLeft'?-Math.max(180,wrap.clientWidth*.65):e.key==='ArrowRight'?Math.max(180,wrap.clientWidth*.65):0;const dy=e.key==='ArrowUp'?-Math.max(120,wrap.clientHeight*.65):e.key==='ArrowDown'?Math.max(120,wrap.clientHeight*.65):0;wrap.scrollBy({left:dx,top:dy,behavior:'auto'});return;
          }
          const move={ArrowLeft:[0,-1],ArrowRight:[0,1],ArrowUp:[-1,0],ArrowDown:[1,0],Tab:[0,e.shiftKey?-1:1]}[e.key];
          if(move){e.preventDefault();selectCell(Math.max(0,Math.min(models.length-1,r+move[0])),Math.max(0,Math.min(defs.length-1,c+move[1])),e.shiftKey&&e.key!=='Tab',true);return;}
          if(options.editable&&e.key.length===1&&!e.metaKey&&!e.ctrlKey&&!e.altKey){e.preventDefault();beginEdit(cell,e.key);}
        };
        td.oncopy=copySelection;td.onpaste=pasteSelection;
      });
    });
    wrap.oncopy=copySelection;wrap.onpaste=pasteSelection;
    wrap.onmouseleave=()=>{state.mouseDown=false;state.mouseMoved=false;};
    const hint=parentEl.createDiv({cls:'schema-studio-grid-hint schema-tools-muted'});
    hint.setText('单击选择；双击文本/数值单元格进入编辑并把光标放到点击位置，不会全选；输入后 Enter 确认。Boolean 双击、Enter 或空格直接 true/false 切换。方向键移动单元格焦点；Ctrl/Cmd + 方向键滚动表格窗口。修改会立即显示“旧值删除线 → 新值”，顶部保存编辑提交。拖拽或 Shift 选择区域；Ctrl/Cmd+C 复制；Excel/WPS 区域可直接 Ctrl/Cmd+V 粘贴。');
    return {wrap,table,state};
  }
  async saveDynamicEdits(rows){
    const allowed=new Set((rows||[]).map(r=>r.file.path));let count=0;
    for(const [filePath,edits] of [...this.pendingEdits.entries()]){if(!allowed.has(filePath)||!edits||!Object.keys(edits).length)continue;const file=this.app.vault.getAbstractFileByPath(filePath);if(!file)continue;await this.app.fileManager.processFrontMatter(file,fm=>{for(const[k,v]of Object.entries(edits))fm[k]=v;});this.pendingEdits.delete(filePath);count++;}
    new Notice(count?`已保存 ${count} 条 Schema 记录`:'没有需要保存的修改');this.render();
  }

  renderApiBrowse(){
    const groups=this.getApiGroups();if(!this.selectedKey&&groups.length)this.selectedKey=groups[0].key;const group=groups.find(x=>x.key===this.selectedKey);if(!group)return this.renderWelcome('接口 Schema','从左侧批量导入 JSON，或选择已有接口查看和编辑字段。');
    const rows=group.rows.filter(r=>!r.schema_orphaned).sort((a,b)=>a.direction.localeCompare(b.direction)||(a.order-b.order)||a.path.localeCompare(b.path));
    this.renderHeader(group.label,group.apiPath||'接口文档',[{text:'保存编辑',onclick:()=>this.saveDynamicEdits(rows)},{text:'JSON 导入 / 更新',primary:true,onclick:()=>{this.page='json-import';this.importState={apiName:group.label,direction:'Request',jsonText:'',jsonFiles:[]};this.render();}}]);
    this.mainEl.createDiv({text:'字段列来自 Fileclass 定义；以后在 ApiField Fileclass 中增删属性，Schema Studio 会自动同步。路径/归属等标识字段只读，其他属性可直接编辑。',cls:'schema-tools-callout'});this.renderGenericEditor(rows,'api');
    const orphan=group.rows.filter(r=>r.schema_orphaned);if(orphan.length)this.mainEl.createDiv({text:`另有 ${orphan.length} 个“疑似删除”节点。`,cls:'schema-tools-muted schema-studio-footnote'});
  }
  renderDbBrowse(){
    const groups=this.getDbGroups();if(!this.selectedKey&&groups.length)this.selectedKey=groups[0].key;const group=groups.find(x=>x.key===this.selectedKey);if(!group)return this.renderWelcome('数据库 Schema','批量导入 DDL，或选择已有数据表查看和编辑列。');
    const rows=group.rows.filter(r=>!r.schema_orphaned).sort((a,b)=>(a.order-b.order)||a.name.localeCompare(b.name));
    this.renderHeader(group.label,group.tablePath||'数据库文档',[{text:'保存编辑',onclick:()=>this.saveDynamicEdits(rows)},{text:'DDL 导入 / 更新',primary:true,onclick:()=>{this.page='ddl-import';this.importState={dialect:'mysql',ddlText:'',ddlFiles:[],focusTable:group.label};this.render();}}]);
    this.mainEl.createDiv({text:'字段列来自 DbColumn Fileclass 定义；自定义属性会自动出现并在重导入时保留。',cls:'schema-tools-callout'});this.renderGenericEditor(rows,'db');
  }

  renderPageHeader(title,subtitle=''){this.renderHeader(title,subtitle,[{text:'返回',onclick:()=>{this.page='browse';this.importState=null;this.render();}}]);}
  renderMultiFileChooser(kind,state,key){
    const row=this.mainEl.createDiv({cls:'schema-studio-source-row'});const label=row.createEl('label',{cls:'schema-studio-file-label'});label.createSpan({text:kind==='json'?'选择 JSON 文件（可多选）':'选择 SQL/DDL 文件（可多选）'});const input=label.createEl('input',{type:'file',attr:{accept:kind==='json'?'.json,application/json':'.sql,.ddl,text/plain,application/sql',multiple:'multiple'}});
    input.onchange=async()=>{const files=[...(input.files||[])];const loaded=[];for(const f of files){try{loaded.push({name:f.name,text:await f.text()});}catch(e){new Notice(`读取 ${f.name} 失败：${e.message}`);}}state[key]=loaded;this.render();};
    row.createDiv({text:'可一次选择多个文件',cls:'schema-tools-muted'});if((state[key]||[]).length){const box=this.mainEl.createDiv({cls:'schema-studio-selected-files'});box.createDiv({text:`已选择 ${state[key].length} 个文件`,cls:'schema-tools-label'});for(const f of state[key])box.createDiv({text:f.name,cls:'schema-studio-file-chip'});}
  }

  renderJsonImport(){
    const state=this.importState||{apiName:'',direction:'Request',jsonText:'',jsonFiles:[]};this.importState=state;this.renderPageHeader('JSON → 接口 Schema','支持 JSON 字符串、单文件和批量文件；批量文件按文件名或 __schema 元信息自动路由。');
    this.mainEl.createDiv({text:'批量命名示例：创建订单.Request.json、创建订单-Response.json。也可以在 JSON 中加入 __schema: { api, direction }，payload/body/data 作为实际样例。导入器只覆盖可推断的结构属性，Fileclass 中的其他自定义属性会保留。',cls:'schema-tools-callout'});
    this.renderMultiFileChooser('json',state,'jsonFiles');
    const form=this.mainEl.createDiv({cls:'schema-studio-form'});new Setting(form).setName('JSON 字符串的接口名称').setDesc('仅用于下方粘贴的 JSON，或单个无法从文件名识别的文件。').addText(t=>t.setValue(state.apiName||'').onChange(v=>state.apiName=v.trim()));new Setting(form).setName('方向').addDropdown(d=>d.addOptions({Request:'Request',Response:'Response'}).setValue(state.direction||'Request').onChange(v=>state.direction=v));
    this.mainEl.createDiv({text:'JSON 字符串（可选）',cls:'schema-tools-label'});const ta=this.mainEl.createEl('textarea',{cls:'schema-tools-textarea',attr:{placeholder:'{\n  "mobile": "13800000000"\n}'}});ta.value=state.jsonText||'';ta.oninput=()=>state.jsonText=ta.value;
    const actions=this.mainEl.createDiv({cls:'schema-tools-actions'});const analyze=actions.createEl('button',{text:'分析全部并查看 Diff',cls:'mod-cta'});analyze.onclick=()=>this.analyzeJson(state);
  }
  buildApiAnalysis(unit){
    const inferred=core.flattenJsonSample(unit.data);const existing=this.plugin.scanApiFields().filter(x=>x.apiName===unit.apiName&&x.direction===unit.direction);const exMap=new Map(existing.map(x=>[x.path,x]));const defaults=this.plugin.defaultPropertiesForDomain('api');
    const incoming=inferred.map(struct=>{const old=exMap.get(struct.path);const base=old?stripCacheKeys(old.fm):Object.assign({},defaults);return Object.assign(base,struct,{key:struct.path});});
    const diff=core.diffRecords(existing.map(x=>Object.assign({key:x.path},stripCacheKeys(x.fm))),incoming,API_IMPORT_MANAGED_KEYS);return {apiName:unit.apiName,direction:unit.direction,sourceName:unit.filename,incoming,existing,diff};
  }
  analyzeJson(state){
    const units=[];const files=state.jsonFiles||[];try{for(const f of files)units.push(extractJsonImportUnit(f.text,f.name,files.length===1?{apiName:state.apiName,direction:state.direction}:{}));if((state.jsonText||'').trim())units.push(extractJsonImportUnit(state.jsonText,'',{apiName:state.apiName,direction:state.direction}));}catch(e){new Notice(`JSON 导入映射失败：${e.message}`);return;}if(!units.length){new Notice('请选择 JSON 文件或粘贴 JSON 字符串');return;}
    const seen=new Set();for(const u of units){const k=`${u.apiName}\u0000${u.direction}`;if(seen.has(k)){new Notice(`批量导入中目标重复：${u.apiName} / ${u.direction}`);return;}seen.add(k);}
    state.analysis=units.map(u=>this.buildApiAnalysis(u));this.page='json-diff';this.render();
  }
  renderDiffDetails(diff){
    const rows=detailedDiffRows(diff);if(!rows.length){this.mainEl.createDiv({text:'没有结构变化。',cls:'schema-tools-muted'});return;}const wrap=this.mainEl.createDiv({cls:'schema-tools-table-wrap schema-studio-diff-table'});const table=wrap.createEl('table',{cls:'schema-tools-table'});const hr=table.createEl('thead').createEl('tr');['状态','字段 / 列','发生变化的属性','修改前','修改后'].forEach(x=>hr.createEl('th',{text:x}));const body=table.createEl('tbody');for(const r of rows){const tr=body.createEl('tr',{cls:`schema-status-${r.status}`});tr.createEl('td',{text:labelStatus(r.status)});tr.createEl('td',{text:r.key});tr.createEl('td',{text:r.property,cls:'schema-studio-diff-property'});tr.createEl('td',{text:diffValue(r.before),cls:'schema-studio-diff-before'});tr.createEl('td',{text:diffValue(r.after),cls:'schema-studio-diff-after'});}
  }
  renderJsonDiff(){
    const state=this.importState,analyses=state?.analysis;if(!analyses){this.page='json-import';return this.render();}
    this.renderHeader('JSON 导入对比','旧值在同一单元格内以删除线显示；新值仍可直接编辑，也支持 Excel / WPS 区域粘贴。',[
      {text:'返回修改导入',onclick:()=>{this.page='json-import';this.render();}},
      {text:'应用全部更新',primary:true,onclick:()=>this.applyJson(state)}
    ]);
    const {defs}=this.getGridDefinitions('api',API_IMPORT_MANAGED_KEYS);
    for(const a of analyses){
      const counts=countStatuses(a.diff);
      this.mainEl.createEl('h3',{text:`${a.apiName} / ${a.direction} · ${a.sourceName}`});
      this.mainEl.createDiv({text:`新增 ${counts.added} · 属性变化 ${counts.changed} · 未变化 ${counts.unchanged} · 源中消失 ${counts.removed}`,cls:'schema-tools-summary'});
      const byDiff=new Map(a.diff.map(d=>[d.key,d])),byIncoming=new Map(a.incoming.map(r=>[r.path,r]));
      const keys=[...a.incoming.map(r=>r.path),...a.diff.filter(d=>d.status==='removed').map(d=>d.key)];
      const models=keys.map(key=>{
        const d=byDiff.get(key),row=byIncoming.get(key);
        if(d?.status==='removed')return{
          key,status:'removed',
          getValue:(name)=>d.before?.[name],
          getBefore:(name)=>d.before?.[name],
          setValue:()=>{},
          readonly:()=>true
        };
        return{
          key,status:d?.status||'unchanged',
          getValue:(name)=>row?.[name],
          getBefore:(name)=>d?.before?.[name],
          setValue:(name,value)=>{if(row)row[name]=value;},
          readonly:(name)=>NON_EDITABLE_IDENTITY_KEYS.has(name)
        };
      });
      this.renderDataGrid(models,defs,{domain:'api',editable:true,showStatus:true});
    }
  }
  async applyOneApiAnalysis(a){
    const now=new Date().toISOString(),folder=normalizePath(this.plugin.settings.apiFieldsFolder);await ensureFolder(this.app,folder);await ensureFolder(this.app,this.plugin.settings.apiDocsFolder);const apiDocPath=normalizePath(`${this.plugin.settings.apiDocsFolder}/${a.apiName}.md`);if(!this.app.vault.getAbstractFileByPath(apiDocPath))await this.app.vault.create(apiDocPath,`# ${a.apiName}\n\n## Request\n\n![[${this.plugin.settings.apiBaseName}#当前接口 Request]]\n\n## Response\n\n![[${this.plugin.settings.apiBaseName}#当前接口 Response]]\n`);
    const exMap=new Map(a.existing.map(x=>[x.path,x]));const className=this.plugin.getFieldDefinitions('api').className;
    for(const r of a.incoming){const old=exMap.get(r.path);const props=stripCacheKeys(r);delete props.key;props.fileClass=props.fileClass||className;props.api=`[[${apiDocPath.replace(/\.md$/,'')}]]`;props.direction=a.direction;props.schema_source='json-sample';props.schema_orphaned=false;props.last_imported_at=now;if(old)await this.app.fileManager.processFrontMatter(old.file,fm=>{Object.assign(fm,props);});else{const path=normalizePath(`${folder}/${core.makeApiFieldFilename(a.apiName,a.direction,r.path)}.md`);await this.app.vault.create(path,`---\n${stringifyYaml(props)}---\n\n${noteBodyApiField(a.apiName,a.direction,r)}`);}}
    for(const d of a.diff.filter(x=>x.status==='removed')){const old=exMap.get(d.key);if(old)await this.app.fileManager.processFrontMatter(old.file,fm=>{fm.schema_orphaned=true;fm.last_imported_at=now;});}
  }
  async applyJson(state){for(const a of state.analysis||[])await this.applyOneApiAnalysis(a);new Notice(`已更新 ${state.analysis?.length||0} 个接口方向 Schema`);this.domain='api';this.selectedKey=state.analysis?.[0]?.apiName||null;this.page='browse';this.importState=null;this.render();}

  renderDdlImport(){
    const state=this.importState||{dialect:'mysql',ddlText:'',ddlFiles:[],focusTable:''};this.importState=state;this.renderPageHeader('DDL → 数据库 Schema','同一批文件使用同一方言；每个 CREATE TABLE 自动路由到对应表。');const form=this.mainEl.createDiv({cls:'schema-studio-form'});new Setting(form).setName('数据库方言').setDesc(DDL_DIALECTS[state.dialect]?.description||'').addDropdown(d=>{for(const x of Object.values(DDL_DIALECTS))d.addOption(x.id,x.label);d.setValue(state.dialect).onChange(v=>{state.dialect=v;this.render();});});this.renderMultiFileChooser('sql',state,'ddlFiles');
    this.mainEl.createDiv({text:'DDL / SQL 字符串（可选）',cls:'schema-tools-label'});const ta=this.mainEl.createEl('textarea',{cls:'schema-tools-textarea schema-tools-ddl',attr:{placeholder:'CREATE TABLE orders (\n  id BIGINT NOT NULL PRIMARY KEY\n);'}});ta.value=state.ddlText||'';ta.oninput=()=>state.ddlText=ta.value;const note=this.mainEl.createDiv({cls:'schema-studio-dialect-note'});note.createDiv({text:`当前适配器：${DDL_DIALECTS[state.dialect].label}`,cls:'schema-studio-dialect-title'});note.createDiv({text:DDL_DIALECTS[state.dialect].description,cls:'schema-tools-muted'});const actions=this.mainEl.createDiv({cls:'schema-tools-actions'});const analyze=actions.createEl('button',{text:'分析全部并查看 Diff',cls:'mod-cta'});analyze.onclick=()=>this.analyzeDdl(state);
  }
  buildDbAnalysis(table,sourceName){
    const existing=this.plugin.scanDbColumns().filter(x=>x.table===table.table),exMap=new Map(existing.map(x=>[x.name,x])),defaults=this.plugin.defaultPropertiesForDomain('db');
    const incoming=table.columns.map(c=>{const old=exMap.get(c.name);const base=old?stripCacheKeys(old.fm):Object.assign({},defaults);const normalized=Object.assign(base,c,{key:c.name});if(c.references)normalized.references=`[[${normalizePath(this.plugin.settings.dbColumnsFolder)}/${core.makeDbColumnFilename(c.references.table,c.references.column)}]]`;else normalized.references='';return normalized;});
    const diff=core.diffRecords(existing.map(x=>Object.assign({key:x.name},stripCacheKeys(x.fm))),incoming,DB_IMPORT_MANAGED_KEYS);return {table:table.table,sourceName,incoming,existing,diff};
  }
  analyzeDdl(state){
    const sources=[...(state.ddlFiles||[])];if((state.ddlText||'').trim())sources.push({name:'DDL 字符串',text:state.ddlText});if(!sources.length){new Notice('请选择 DDL 文件或粘贴 SQL');return;}const analyses=[];const seen=new Set();try{for(const source of sources){const parsed=parseDdlWithDialect(source.text,state.dialect);for(const t of parsed){const key=t.table.toLowerCase();if(seen.has(key))throw new Error(`同一批次重复定义表：${t.table}`);seen.add(key);analyses.push(this.buildDbAnalysis(t,source.name));}}}catch(e){new Notice(`DDL 解析失败：${e.message}`);return;}if(!analyses.length){new Notice(`没有识别到 ${DDL_DIALECTS[state.dialect].label} CREATE TABLE`);return;}state.analysis=analyses;this.page='ddl-diff';this.render();
  }
  renderDdlDiff(){
    const state=this.importState,analyses=state?.analysis;if(!analyses){this.page='ddl-import';return this.render();}
    this.renderHeader(`${DDL_DIALECTS[state.dialect].label} DDL 导入对比`,'变化直接显示在字段表单元格中：删除线为旧值，后面的值为本次导入结果。',[
      {text:'返回修改导入',onclick:()=>{this.page='ddl-import';this.render();}},
      {text:'应用全部更新',primary:true,onclick:()=>this.applyDdl(state)}
    ]);
    const {defs}=this.getGridDefinitions('db',DB_IMPORT_MANAGED_KEYS);
    for(const a of analyses){
      const counts=countStatuses(a.diff);
      this.mainEl.createEl('h3',{text:`${a.table} · ${a.sourceName}`});
      this.mainEl.createDiv({text:`新增 ${counts.added} · 属性变化 ${counts.changed} · 未变化 ${counts.unchanged} · DDL 中消失 ${counts.removed}`,cls:'schema-tools-summary'});
      const byDiff=new Map(a.diff.map(d=>[d.key,d])),byIncoming=new Map(a.incoming.map(r=>[r.name,r]));
      const keys=[...a.incoming.map(r=>r.name),...a.diff.filter(d=>d.status==='removed').map(d=>d.key)];
      const models=keys.map(key=>{
        const d=byDiff.get(key),row=byIncoming.get(key);
        if(d?.status==='removed')return{
          key,status:'removed',
          getValue:(name)=>d.before?.[name],
          getBefore:(name)=>d.before?.[name],
          setValue:()=>{},
          readonly:()=>true
        };
        return{
          key,status:d?.status||'unchanged',
          getValue:(name)=>row?.[name],
          getBefore:(name)=>d?.before?.[name],
          setValue:(name,value)=>{if(row)row[name]=value;},
          readonly:(name)=>NON_EDITABLE_IDENTITY_KEYS.has(name)
        };
      });
      this.renderDataGrid(models,defs,{domain:'db',editable:true,showStatus:true});
    }
  }
  async applyDdl(state){
    const now=new Date().toISOString();await ensureFolder(this.app,this.plugin.settings.dbColumnsFolder);await ensureFolder(this.app,this.plugin.settings.dbDocsFolder);const className=this.plugin.getFieldDefinitions('db').className;
    for(const a of state.analysis){const tableDocPath=normalizePath(`${this.plugin.settings.dbDocsFolder}/${a.table}.md`);if(!this.app.vault.getAbstractFileByPath(tableDocPath))await this.app.vault.create(tableDocPath,`# ${a.table}\n\n## 字段\n\n![[${this.plugin.settings.dbBaseName}#当前数据表]]\n`);const exMap=new Map(a.existing.map(x=>[x.name,x]));for(const r of a.incoming){const old=exMap.get(r.name);const props=stripCacheKeys(r);delete props.key;props.fileClass=props.fileClass||className;props.table=`[[${tableDocPath.replace(/\.md$/,'')}]]`;props.schema_source='ddl';props.schema_dialect=state.dialect;props.schema_orphaned=false;props.last_imported_at=now;if(!r.default_value)delete props.default_value;if(!r.ddl_comment)delete props.ddl_comment;if(!r.references)delete props.references;if(old)await this.app.fileManager.processFrontMatter(old.file,fm=>{Object.assign(fm,props);if(!r.default_value)delete fm.default_value;if(!r.ddl_comment)delete fm.ddl_comment;if(!r.references)delete fm.references;});else{const path=normalizePath(`${this.plugin.settings.dbColumnsFolder}/${core.makeDbColumnFilename(a.table,r.name)}.md`);await this.app.vault.create(path,`---\n${stringifyYaml(props)}---\n\n${noteBodyDbColumn(a.table,r)}`);}}for(const d of a.diff.filter(x=>x.status==='removed')){const old=exMap.get(d.key);if(old)await this.app.fileManager.processFrontMatter(old.file,fm=>{fm.schema_orphaned=true;fm.last_imported_at=now;});}}
    new Notice(`已更新 ${state.analysis?.length||0} 张数据库表`);this.domain='db';this.selectedKey=state.focusTable||state.analysis?.[0]?.table||null;this.page='browse';this.importState=null;this.render();
  }
}

class SchemaStudioUnsavedModal extends Modal {
  constructor(app,studio){super(app);this.studio=studio;this.busy=false;}
  onOpen(){
    this.modalEl.addClass('schema-studio-unsaved-modal');this.contentEl.empty();
    this.contentEl.createEl('h2',{text:'有未保存的修改'});
    this.contentEl.createDiv({text:this.studio.unsavedSummary(),cls:'schema-studio-unsaved-summary'});
    this.contentEl.createDiv({text:'保存后关闭，或放弃这些修改。Esc 取消关闭并返回 Schema Studio。',cls:'schema-tools-muted'});
    const actions=this.contentEl.createDiv({cls:'schema-studio-unsaved-actions'});
    const cancel=actions.createEl('button',{text:'取消  Esc'});
    const discard=actions.createEl('button',{text:'不保存'});
    const save=actions.createEl('button',{text:'保存并关闭  ↵',cls:'mod-cta'});
    const doSave=async()=>{if(this.busy)return;this.busy=true;save.disabled=discard.disabled=cancel.disabled=true;this.close();await this.studio.saveDirtyAndClose();};
    cancel.onclick=()=>this.close();
    discard.onclick=()=>{if(this.busy)return;this.close();this.studio.discardDirtyAndClose();};
    save.onclick=doSave;
    this.modalEl.addEventListener('keydown',(e)=>{
      if(e.key==='Enter'&&!e.shiftKey&&!e.altKey){e.preventDefault();e.stopPropagation();doSave();return;}
      if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='s'){e.preventDefault();e.stopPropagation();doSave();}
    },true);
    requestAnimationFrame(()=>save.focus());
  }
  onClose(){this.studio._closePromptOpen=false;this.contentEl.empty();}
}

function countStatuses(diff){const c={added:0,changed:0,unchanged:0,removed:0};for(const d of diff)c[d.status]=(c[d.status]||0)+1;return c;}
function labelStatus(s){return {added:'新增',changed:'变化',unchanged:'未变',removed:'消失'}[s]||s;}
function changeSummary(d){if(!d||d.status!=='changed')return '';return '变更：'+d.changes.map(k=>`${k} ${JSON.stringify(d.before?.[k]??'')} → ${JSON.stringify(d.after?.[k]??'')}`).join('；');}

SchemaToolsPlugin._test = { core, DDL_DIALECTS, parseDdlWithDialect, parseMySqlDdl, parseOracleDdl, parseJsonFilenameTarget, extractJsonImportUnit, detailedDiffRows, normalizeDirection, parseClipboardTable, clipboardValueForType, displayGridValue, valuesEqual, buildDemoFilePlan, demoPaths, SchemaStudioModal, SchemaStudioUnsavedModal, DemoInstallModal, DemoRestoreModal };
module.exports = SchemaToolsPlugin;
