// A fast, dependency-free reimplementation of makefun-site 1.0.0's build.
// Written from scratch from the makefun-site README and its reference code's
// observable behaviour: same answers for every input, byte for byte.
// No vendor code is copied here; this module imports nothing.
//
// Layout of the work:
//   - text helpers: escapeHtml, slugify (cached, ASCII fast path), longDate
//   - front matter: strict parser, same refusals, same messages
//   - markdown: single-pass renderer (no token array), bulk escaping
//   - templates: parsed once, compiled to JS functions (new Function) so a
//     render is straight-line code instead of a node walk
//   - build(): the eight pipeline stages, in the reference's order

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const RESERVED = ['posts', 'tags', 'page'];
const SLUG_MAX = 64;

// ---------------------------------------------------------------- text

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESCAPE_RE = /[&<>"']/g;
export function escapeHtml(text) {
  return text.replace(ESCAPE_RE, (c) => ESCAPES[c]);
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const longDateCache = new Map();
function longDate(date) {
  let s = longDateCache.get(date);
  if (s === undefined) {
    const [y, m, d] = date.split('-');
    s = `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
    longDateCache.set(date, s);
  }
  return s;
}

const slugCache = new Map();
const ASCII_ONLY = /^[\x00-\x7F]*$/;
export function slugify(text) {
  const hit = slugCache.get(text);
  if (hit !== undefined) return hit;
  let out;
  if (ASCII_ONLY.test(text)) {
    // NFKD is the identity on ASCII and ASCII holds no combining marks, so
    // the reference's loop is exactly: lowercase, runs of non [a-z0-9] -> '-'.
    out = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  } else {
    const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
    let o = '';
    let gap = false;
    for (const ch of plain) {
      let keep = null;
      if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
      else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
      if (keep === null) {
        gap = o.length > 0;
        continue;
      }
      if (gap) o += '-';
      gap = false;
      o += keep;
    }
    out = o.slice(0, SLUG_MAX).replace(/-+$/, '');
  }
  if (out === '') out = 'untitled';
  slugCache.set(text, out);
  return out;
}

function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

// ---------------------------------------------------------------- front matter

const FM_KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const FM_LINE = /^([a-z_]+):(?: (.*))?$/;
const FM_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FM_NAME = /^[a-z0-9-]+$/;
const FM_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FM_TAG = /^[^"[\]]+$/;
const FM_BLANK = /^[ \t]*$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare. */
function stringOf(raw) {
  if (raw[0] === '"') {
    if (raw.length < 2 || raw[raw.length - 1] !== '"') return { error: 'a quoted string is not closed' };
    const inner = raw.slice(1, -1);
    if (!inner.includes('"') && !inner.includes('\\')) return { value: inner };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw[0] === '[') return { error: 'a bare string opens on [' };
  return { value: raw };
}

function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = FM_DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) {
        return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      }
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !FM_TAG.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return FM_NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return FM_SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/** A source's front matter and body: { data, body }, or { error }. */
function parseFrontMatter(text) {
  // First line must be exactly '---'; find the closing line by indexOf
  // instead of splitting the whole body (bodies are long, FM is ~10 lines).
  const firstNL = text.indexOf('\n');
  const firstLine = firstNL === -1 ? text : text.slice(0, firstNL);
  if (firstLine !== '---') return { error: 'no front matter' };
  let closeIdx = -1;
  let pos = firstNL;
  while (true) {
    const idx = text.indexOf('\n---', pos);
    if (idx === -1) break;
    const after = idx + 4;
    if (after === text.length || text[after] === '\n') { closeIdx = idx; break; }
    pos = idx + 1;
  }
  if (closeIdx === -1) return { error: 'the front matter is not closed' };
  const data = {};
  // FM lines are text[firstNL+1 .. closeIdx-1]; line numbers are 2-based here.
  const fmLines = text.slice(firstNL + 1, closeIdx).split('\n');
  for (let k = 0; k < fmLines.length; k++) {
    const line = fmLines[k];
    if (FM_BLANK.test(line) || line[0] === '#') continue;
    const m = FM_LINE.exec(line);
    if (!m) return { error: `line ${k + 2} is not "key: value"` };
    const key = m[1];
    const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
    if (!FM_KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  const bodyStart = closeIdx + 4 < text.length && text[closeIdx + 4] === '\n' ? closeIdx + 5 : closeIdx + 4;
  return { data, body: text.slice(bodyStart) };
}

// ---------------------------------------------------------------- markdown

const BLANK = /^[ \t]*$/;
const FENCE_OPEN = /^```([A-Za-z0-9_+-]*)[ \t]*$/;
const FENCE_CLOSE = /^```[ \t]*$/;
const HEADING_RE = /^(#{1,6})[ \t]+(.*?)[ \t]*$/;
const HR_RE = /^(?:---|\*\*\*)[ \t]*$/;
const BULLET_RE = /^[-*] (.*)$/;
const ORDERED_RE = /^(\d{1,9})\. (.*)$/;
const CONTINUED_RE = /^ {2,}\S/;
const WS_RUN = /\s/;

function headingOf(line) {
  const m = HEADING_RE.exec(line);
  return m === null || m[2] === '' ? null : { depth: m[1].length, text: m[2] };
}

function endsParagraph(line) {
  if (line.length === 0) return true;
  const c0 = line[0];
  if (c0 === ' ' || c0 === '\t') return BLANK.test(line);
  if (c0 === '`') return FENCE_OPEN.test(line);
  if (c0 === '#') return headingOf(line) !== null;
  if (c0 === '-' || c0 === '*') return HR_RE.test(line);
  return false;
}

const trimLine = (line) => {
  let a = 0;
  let b = line.length;
  while (a < b && (line[a] === ' ' || line[a] === '\t')) a++;
  while (b > a && (line[b - 1] === ' ' || line[b - 1] === '\t')) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
};

const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);
const ANY_SPECIAL_RE = /[&<>"'\\`*\[]/g;

/** Whether position `j` is consumed by an escape pair: the backslash run
 * immediately before it (within [from, j)) has odd length. */
function isEscaped(s, j, from) {
  let k = j - 1;
  let n = 0;
  while (k >= from && s[k] === '\\') { n++; k--; }
  return (n % 2) === 1;
}

/** First index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  let j = s.indexOf(what, from);
  while (j !== -1) {
    if (isEscaped(s, j, from)) { j = s.indexOf(what, j + 1); continue; }
    return j;
  }
  return -1;
}

/** First single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  let j = s.indexOf('*', from);
  while (j !== -1) {
    if (isEscaped(s, j, from)) { j = s.indexOf('*', j + 1); continue; }
    if (s[j + 1] === '*') { j = s.indexOf('*', j + 2); continue; }
    return j;
  }
  return -1;
}

/** `s` rendered inline; `env.link(target)` is a link's href. */
function inline(s, env) {
  // One scan over ALL special chars (HTML escapables + markup marks): a
  // plain run between two of them holds nothing needing work, so it is
  // appended verbatim — no second escaping pass over it, no escapeHtml
  // call per chunk.
  ANY_SPECIAL_RE.lastIndex = 0;
  if (ANY_SPECIAL_RE.exec(s) === null) return s;
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    ANY_SPECIAL_RE.lastIndex = i;
    const m = ANY_SPECIAL_RE.exec(s);
    const j = m === null ? -1 : m.index;
    if (j === -1) {
      out += s.slice(i);
      break;
    }
    if (j > i) out += s.slice(i, j);
    const c = s[j];
    if (c === '&') { out += '&amp;'; i = j + 1; continue; }
    if (c === '<') { out += '&lt;'; i = j + 1; continue; }
    if (c === '>') { out += '&gt;'; i = j + 1; continue; }
    if (c === '"') { out += '&quot;'; i = j + 1; continue; }
    if (c === "'") { out += '&#39;'; i = j + 1; continue; }
    if (c === '\\') {
      if (j + 1 < n && ESCAPABLE.has(s[j + 1])) {
        out += s[j + 1] === '>' ? '&gt;' : s[j + 1];
        i = j + 2;
      } else {
        out += '\\';
        i = j + 1;
      }
      continue;
    }
    if (c === '`') {
      const k = s.indexOf('`', j + 1);
      if (k > j + 1) {
        out += `<code>${escapeHtml(s.slice(j + 1, k))}</code>`;
        i = k + 1;
      } else {
        out += '`';
        i = j + 1;
      }
      continue;
    }
    if (c === '*') {
      if (s[j + 1] === '*') {
        const k = findUnescaped(s, '**', j + 2);
        if (k > j + 2) {
          out += `<strong>${inline(s.slice(j + 2, k), env)}</strong>`;
          i = k + 2;
        } else {
          out += '**';
          i = j + 2;
        }
        continue;
      }
      const k = findSingleStar(s, j + 1);
      if (k > j + 1) {
        out += `<em>${inline(s.slice(j + 1, k), env)}</em>`;
        i = k + 1;
      } else {
        out += '*';
        i = j + 1;
      }
      continue;
    }
    // '['
    const k = findUnescaped(s, ']', j + 1);
    const mm = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
    const target = mm === -1 ? '' : s.slice(k + 2, mm);
    if (target !== '' && !WS_RUN.test(target)) {
      out += `<a href="${escapeHtml(env.link(target))}">${inline(s.slice(j + 1, k), env)}</a>`;
      i = mm + 1;
      continue;
    }
    out += '[';
    i = j + 1;
  }
  return out;
}

/** `src` rendered: HTML, table of contents, and excerpt. */
function renderMarkdown(src, env) {
  const lines = src.split('\n');
  const n = lines.length;
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  let i = 0;
  while (i < n) {
    const line = lines[i];
    const c0 = line.length === 0 ? '' : line[0];
    if (c0 === '' || c0 === ' ' || c0 === '\t') {
      if (BLANK.test(line)) {
        i++;
        continue;
      }
    } else if (c0 === '`') {
      const fence = FENCE_OPEN.exec(line);
      if (fence !== null) {
        i++;
        const parts = [];
        while (i < n && !FENCE_CLOSE.test(lines[i])) {
          parts.push(`${escapeHtml(lines[i])}\n`);
          i++;
        }
        i++;
        const cls = fence[1] === '' ? '' : ` class="language-${escapeHtml(fence[1])}"`;
        blocks.push(`<pre><code${cls}>${parts.join('')}</code></pre>\n`);
        continue;
      }
    } else if (c0 === '#') {
      const heading = headingOf(line);
      if (heading !== null) {
        const id = uniqueSlug(slugify(heading.text), ids);
        const html = inline(heading.text, env);
        blocks.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>\n`);
        if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
        i++;
        continue;
      }
    } else if (c0 === '-' || c0 === '*') {
      if (HR_RE.test(line)) {
        blocks.push('<hr>\n');
        i++;
        continue;
      }
    } else if (c0 === '>') {
      const body = [];
      while (i < n && lines[i][0] === '>') body.push(lines[i++].replace(/^> ?/, ''));
      const kept = [];
      for (const l of body) {
        const t = trimLine(l);
        if (t !== '') kept.push(t);
      }
      blocks.push(kept.length === 0 ? '<blockquote>\n</blockquote>\n' : `<blockquote>\n<p>${inline(kept.join('\n'), env)}</p>\n</blockquote>\n`);
      continue;
    }
    const bullet = (c0 === '-' || c0 === '*') ? BULLET_RE.exec(line) : null;
    const ordered = (c0 >= '0' && c0 <= '9') ? ORDERED_RE.exec(line) : null;
    if (bullet !== null || ordered !== null) {
      const isOrdered = ordered !== null;
      const marker = isOrdered ? ORDERED_RE : BULLET_RE;
      const items = [];
      while (i < n) {
        const m = marker.exec(lines[i]);
        if (m !== null) {
          items.push([trimLine(isOrdered ? m[2] : m[1])]);
          i++;
        } else if (CONTINUED_RE.test(lines[i])) {
          items[items.length - 1].push(trimLine(lines[i]));
          i++;
        } else break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const start = isOrdered ? Number(ordered[1]) : 1;
      const open = isOrdered && start !== 1 ? `<ol start="${start}">` : `<${tag}>`;
      const parts = [open, '\n'];
      for (const item of items) parts.push(`<li>${inline(item.join('\n'), env)}</li>\n`);
      parts.push(`</${tag}>`);
      blocks.push(`${parts.join('')}\n`);
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const html = inline(body.join('\n'), env);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>\n`);
  }
  return { html: blocks.join(''), toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

class TemplateError extends Error {}

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}; a standalone tag's line goes with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The value at `path` in the scope chain: first name from the nearest scope holding it. */
function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: string itself, a number's digits, true/false, an array joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** Runtime helpers the compiled templates call. */
const R = {
  esc: escapeHtml,
  text: textOf,
  truthy,
  lookup,
  inc(C, name, sc, depth) {
    if (depth >= INCLUDE_DEPTH) return '';
    const f = C.get(name);
    if (f === undefined) return '';
    // Case-constant templates (output depends only on site/tags/recent and
    // the depth) are rendered once per (name, depth) within a case.
    if (C._cf !== undefined && C._cf.get(name) === true) {
      const key = `${name}\n${depth}`;
      const hit = C._cc.get(key);
      if (hit !== undefined) return hit;
      const out = f(sc, depth + 1, C);
      C._cc.set(key, out);
      return out;
    }
    return f(sc, depth + 1, C);
  },
};

/** Roots that are case-level data (same object across all renders of a case). */
const CASE_ROOTS = new Set(['site', 'tags', 'recent']);

/** Whether a template's output depends only on case-level data and the
 * include depth: safe to render once per (name, depth) and reuse within a
 * case. Static analysis over the parsed nodes; `bound` holds loop-var names
 * bound by enclosing fors over constant sources. */
function constCheck(nodes, bound, parsed, memo, seen) {
  for (const node of nodes) {
    if (node.kind === 'text') continue;
    if (node.kind === 'var' || node.kind === 'raw') {
      if (!CASE_ROOTS.has(node.path[0]) && !bound.has(node.path[0])) return false;
    } else if (node.kind === 'if') {
      if (!CASE_ROOTS.has(node.path[0]) && !bound.has(node.path[0])) return false;
      if (!constCheck(node.then, bound, parsed, memo, seen)) return false;
      if (node.else !== null && !constCheck(node.else, bound, parsed, memo, seen)) return false;
    } else if (node.kind === 'for') {
      if (!CASE_ROOTS.has(node.path[0]) && !bound.has(node.path[0])) return false;
      const b2 = new Set(bound);
      b2.add(node.name);
      b2.add('loop');
      if (!constCheck(node.body, b2, parsed, memo, seen)) return false;
    } else if (node.kind === 'include') {
      if (!constOf(node.name, parsed, memo, seen)) return false;
    }
  }
  return true;
}

function constOf(name, parsed, memo, seen) {
  if (memo.has(name)) return memo.get(name);
  if (!parsed.has(name)) return true; // a missing template renders ''
  if (seen.has(name)) return true; // cycle back-edge: depth-bounded, case-determined
  seen.add(name);
  const ok = constCheck(parsed.get(name), new Set(), parsed, memo, seen);
  seen.delete(name);
  memo.set(name, ok);
  return ok;
}

/**
 * A parsed template compiled to a render function (sc, depth, C) -> string.
 * Template source is embedded only through JSON.stringify, so no template
 * text can escape its string literal. The generated code is straight-line
 * JS: text pushes, lookups, real if/for control flow, include calls.
 */
function compileTemplate(nodes) {
  let uid = 0;
  const gen = (list, sv) => {
    let c = '';
    for (const node of list) {
      if (node.kind === 'text') c += `o+=${JSON.stringify(node.text)};`;
      else if (node.kind === 'var') c += `o+=R.esc(R.text(R.lookup(${sv},${JSON.stringify(node.path)})));`;
      else if (node.kind === 'raw') c += `o+=R.text(R.lookup(${sv},${JSON.stringify(node.path)}));`;
      else if (node.kind === 'if') {
        const cond = `R.truthy(R.lookup(${sv},${JSON.stringify(node.path)}))`;
        c += `if(${node.not ? '!' : ''}${cond}){${gen(node.then, sv)}}`;
        if (node.else !== null) c += `else{${gen(node.else, sv)}}`;
      } else if (node.kind === 'for') {
        const k = `k${uid++}`;
        const sv2 = `s${uid++}`;
        const lp = `l${uid++}`;
        // One scope + one loop object per loop (not per item): mutated per
        // iteration. The loop var is assigned before .loop so that a var
        // named "loop" still loses to the loop object, as in the reference.
        c += `{const xs=R.lookup(${sv},${JSON.stringify(node.path)});if(Array.isArray(xs)){const ${sv2}={vars:{},parent:${sv}};const ${lp}={index:0,first:false,last:false,length:xs.length};for(let ${k}=0;${k}<xs.length;${k}++){${sv2}.vars[${JSON.stringify(node.name)}]=xs[${k}];${sv2}.vars.loop=${lp};${lp}.index=${k}+1;${lp}.first=${k}===0;${lp}.last=${k}===xs.length-1;${gen(node.body, sv2)}}}}`;
      } else if (node.kind === 'include') {
        c += `o+=R.inc(C,${JSON.stringify(node.name)},${sv},depth);`;
      }
    }
    return c;
  };
  const factory = new Function('R', `return function(sc,depth,C){let o='';${gen(nodes, 'sc')}return o;}`);
  return factory(R);
}

// ---------------------------------------------------------------- build

// Count runs of non-whitespace (exactly /\S+/g's \s set) without allocating
// the match array: reading_minutes only needs the count.
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const ws = c === 32 || c === 9 || c === 10 || c === 13 || c === 12 || c === 11
      || c === 0x00a0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a)
      || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f
      || c === 0x3000 || c === 0xfeff;
    if (ws) inWord = false;
    else if (!inWord) { n++; inWord = true; }
  }
  return n;
}

/** `rel` from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/** A post's card, as lists show it. */
function cardOf(s) {
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  };
}

const linkOf = (s) =>
  s === null
    ? null
    : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) };

/** A page as its layout reads it (card built once per source, then reused). */
function pageOf(s) {
  if (s.card === undefined) s.card = cardOf(s);
  const c = s.card;
  return {
    title: c.title,
    url: c.url,
    date: c.date,
    date_long: c.date_long,
    summary: c.summary,
    excerpt: c.excerpt,
    reading_minutes: c.reading_minutes,
    tags: c.tags,
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  };
}

/** One site's output tree: path -> text. */
export function run(input) {
  const parsed = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      parsed.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const templates = new Map();
  for (const [name, nodes] of parsed) templates.set(name, compileTemplate(nodes));
  const constMemo = new Map();
  templates._cf = new Map([...parsed.keys()].map((n) => [n, constOf(n, parsed, constMemo, new Set())]));
  templates._cc = new Map();
  const base = input.site.base_url.replace(/\/+$/, '');
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.includes('\r') ? f.content.replace(/\r\n?/g, '\n') : f.content });
    else statics.push({ path: f.path, content: f.content });
  }

  // Front matter: refusals and drafts, checks in order, first failure reported.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = s.path.startsWith('tags/') ? 'tags' : s.path.startsWith('page/') ? 'page' : undefined;
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // Permalinks: slug unique in its directory, in source order.
  const taken = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // Markdown: each body's HTML, its links resolved.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (SCHEME_RE.test(target) || target[0] === '/' || target[0] === '#') return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
        broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // Collections: posts, newest first, then by slug.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // Tags: grouped by slug, first spelling kept, ordered by count then slug.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name);
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push(name);
      }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (!s.post) {
      s.tagRefs = ownTags(s).map((name) => {
        const slug = slugify(name);
        return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
      });
    }
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // Layouts.
  const cards = new Map();
  for (const p of posts) {
    p.card = cardOf(p);
    cards.set(p, p.card);
  }
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const output = {};
  const render = (name, vars) => {
    const fn = templates.get(name);
    return fn === undefined ? null : fn({ vars: { site, tags: allTags, recent, ...vars }, parent: null }, 0, templates);
  };
  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const indexPages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= indexPages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: indexPages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === indexPages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // Report.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
