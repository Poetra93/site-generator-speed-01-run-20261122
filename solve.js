// makefun-site 1.0.0 drop-in, written fresh: same outputs, faster path.
// run(input) -> { path: text } for one generated site. No deps, no I/O.

const CMP = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const ESCMAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g;
const NEED_ESC = /[&<>"']/;
const NEED_MD = /[\\`*[]/;
const STOP_RE = /[\\`*[\]&<>"']/g;

export function escapeHtml(s) {
  if (!NEED_ESC.test(s)) return s;
  return s.replace(ESC_RE, (c) => ESCMAP[c]);
}

function longDate(d) {
  return Number(d.slice(8, 10)) + ' ' + MONTHS[Number(d.slice(5, 7)) - 1] + ' ' + d.slice(0, 4);
}

// Slug: NFKD, strip combining marks, lowercase A-Z, runs of other chars -> one '-'.
function slugify(text, cache) {
  const hit = cache.get(text);
  if (hit !== undefined) return hit;
  const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const ch = plain[i];
    let keep = '';
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    else { if (out.length > 0) gap = true; continue; }
    if (gap) { out += '-'; gap = false; }
    out += keep;
  }
  out = out.slice(0, 64).replace(/-+$/, '');
  const s = out === '' ? 'untitled' : out;
  cache.set(text, s);
  return s;
}

function uniqueSlug(slug, taken) {
  if (!taken.has(slug)) { taken.add(slug); return slug; }
  let n = 2, out;
  do { out = slug + '-' + n++; } while (taken.has(out));
  taken.add(out);
  return out;
}

// ---- front matter ----
const KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);
const LINE_RE = /^([a-z_]+):(?: (.*))?$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAME_RE = /^[a-z0-9-]+$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG_RE = /^[^"[\]]+$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function strVal(raw) {
  if (raw.charCodeAt(0) === 34) { // "
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return 'a quoted string is not closed';
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return 'a quoted string holds an escape other than \\" or \\\\';
        out += n; i++;
      } else if (c === '"') return 'a quoted string holds a stray quote';
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return 'a bare string opens on ['; // [
  return { value: raw };
}

function keyVal(key, raw) {
  switch (key) {
    case 'title': case 'summary': {
      const s = strVal(raw);
      return typeof s === 'string' ? 'key "' + key + '": ' + s : s;
    }
    case 'date': {
      const m = DATE_RE.exec(raw);
      const y = m ? +m[1] : 0, mo = m ? +m[2] : 0, d = m ? +m[3] : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo))
        return 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)';
      return { value: raw };
    }
    case 'tags': {
      if (raw[0] !== '[' || raw[raw.length - 1] !== ']') return 'key "tags": not a list [a, b]';
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',');
      for (let i = 0; i < tags.length; i++) tags[i] = tags[i].trim();
      for (const t of tags) if (t === '' || !TAG_RE.test(t)) return 'key "tags": an empty tag, or one holding " [ or ]';
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : 'key "draft": true or false';
    case 'layout':
      return NAME_RE.test(raw) ? { value: raw } : 'key "layout": not a template name';
    case 'slug':
      return SLUG_RE.test(raw) && raw.length <= 64 ? { value: raw } : 'key "slug": not a slug';
    default:
      return 'unknown key "' + key + '"';
  }
}

function parseFM(text) {
  const lines = text.split('\n');
  if (lines[0] !== '---') return { error: 'no front matter' };
  let close = -1;
  for (let i = 1; i < lines.length; i++) if (lines[i] === '---') { close = i; break; }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let i = 1; i < close; i++) {
    const line = lines[i];
    if (/^[ \t]*$/.test(line) || line[0] === '#') continue;
    const m = LINE_RE.exec(line);
    if (!m) return { error: 'line ' + (i + 1) + ' is not "key: value"' };
    const key = m[1];
    const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
    if (!KEYS.has(key)) return { error: 'unknown key "' + key + '"' };
    if (Object.hasOwn(data, key)) return { error: 'key "' + key + '" is given twice' };
    if (raw === '') return { error: 'key "' + key + '" has no value' };
    const v = keyVal(key, raw);
    if (typeof v === 'string') return { error: v };
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: lines.slice(close + 1).join('\n') };
}

// ---- markdown ----
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);
const FENCE_OPEN = /^```([A-Za-z0-9_+-]*)[ \t]*$/;
const FENCE_CLOSE = /^```[ \t]*$/;
const HR_RE = /^(?:---|\*\*\*)[ \t]*$/;
const ORDERED_RE = /^(\d{1,9})\. (.*)$/;

function isBlank(line) {
  for (let i = 0; i < line.length; i++) { const c = line[i]; if (c !== ' ' && c !== '\t') return false; }
  return true;
}
function trimL(line) {
  let a = 0, b = line.length;
  while (a < b && (line[a] === ' ' || line[a] === '\t')) a++;
  while (b > a && (line[b - 1] === ' ' || line[b - 1] === '\t')) b--;
  return line.slice(a, b);
}
function headingOf(line) {
  let n = 0;
  while (n < 6 && line[n] === '#') n++;
  if (n === 0) return null;
  const c = line[n];
  if (c !== ' ' && c !== '\t') return null;
  const text = trimL(line.slice(n));
  return text === '' ? null : { depth: n, text };
}
function endsPara(line) {
  return isBlank(line) || FENCE_OPEN.test(line) || headingOf(line) !== null || HR_RE.test(line);
}
function findUnesc(s, what, from) {
  for (let j = from; j <= s.length - what.length; j++) {
    if (s[j] === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) { j++; continue; }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}
function findStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) { j++; continue; }
    if (c !== '*') continue;
    if (s[j + 1] === '*') { j++; continue; }
    return j;
  }
  return -1;
}

function inlineInto(s, link, out) {
  if (!NEED_MD.test(s) && !NEED_ESC.test(s)) { out.push(s); return; }
  let i = 0;
  const n = s.length;
  STOP_RE.lastIndex = 0;
  while (i < n) {
    // Fast run of plain characters: none of them needs escaping or parsing.
    STOP_RE.lastIndex = i;
    const m = STOP_RE.exec(s);
    const j = m === null ? n : m.index;
    if (j > i) { out.push(s.slice(i, j)); i = j; continue; }
    if (i >= n) break;
    const c = s[i];
    if (c === '\\' && i + 1 < n && ESCAPABLE.has(s[i + 1])) { out.push(escapeHtml(s[i + 1])); i += 2; continue; }
    if (c === '`') {
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) { out.push('<code>', escapeHtml(s.slice(i + 1, j)), '</code>'); i = j + 1; }
      else { out.push('`'); i++; }
      continue;
    }
    if (c === '*') {
      if (s[i + 1] === '*') {
        const j = findUnesc(s, '**', i + 2);
        if (j > i + 2) { out.push('<strong>'); inlineInto(s.slice(i + 2, j), link, out); out.push('</strong>'); i = j + 2; }
        else { out.push('**'); i += 2; }
        continue;
      }
      const j = findStar(s, i + 1);
      if (j > i + 1) { out.push('<em>'); inlineInto(s.slice(i + 1, j), link, out); out.push('</em>'); i = j + 1; }
      else { out.push('*'); i++; }
      continue;
    }
    if (c === '[') {
      const k = findUnesc(s, ']', i + 1);
      const m = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = m === -1 ? '' : s.slice(k + 2, m);
      if (target !== '' && !/\s/.test(target)) {
        out.push('<a href="', escapeHtml(link(target)), '">');
        inlineInto(s.slice(i + 1, k), link, out);
        out.push('</a>');
        i = m + 1;
        continue;
      }
      out.push('['); i++;
      continue;
    }
    out.push(escapeHtml(c));
    i++;
  }
}
function inline(s, link) {
  const out = [];
  inlineInto(s, link, out);
  return out.join('');
}

function renderMD(src, link, slugCache) {
  const lines = src.split('\n');
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  let i = 0;
  const L = lines.length;
  while (i < L) {
    const line = lines[i];
    if (isBlank(line)) { i++; continue; }
    const fence = FENCE_OPEN.exec(line);
    if (fence !== null) {
      const body = [];
      i++;
      while (i < L && !FENCE_CLOSE.test(lines[i])) body.push(lines[i++]);
      i++;
      const cls = fence[1] === '' ? '' : ' class="language-' + escapeHtml(fence[1]) + '"';
      let code = '';
      for (const l of body) code += escapeHtml(l) + '\n';
      blocks.push('<pre><code' + cls + '>' + code + '</code></pre>');
      continue;
    }
    const h = headingOf(line);
    if (h !== null) {
      const id = uniqueSlug(slugify(h.text, slugCache), ids);
      const html = inline(h.text, link);
      blocks.push('<h' + h.depth + ' id="' + id + '">' + html + '</h' + h.depth + '>');
      if (h.depth === 2 || h.depth === 3) toc.push({ level: h.depth, id, html });
      i++;
      continue;
    }
    if (HR_RE.test(line)) { blocks.push('<hr>'); i++; continue; }
    if (line[0] === '>') {
      const body = [];
      while (i < L && lines[i][0] === '>') body.push(lines[i++].replace(/^> ?/, ''));
      const inner = [];
      for (const l of body) { const t = trimL(l); if (t !== '') inner.push(t); }
      blocks.push(inner.length === 0 ? '<blockquote>\n</blockquote>' : '<blockquote>\n<p>' + inline(inner.join('\n'), link) + '</p>\n</blockquote>');
      continue;
    }
    const bullet = (line[0] === '-' || line[0] === '*') && line[1] === ' ';
    const ordered = bullet ? null : ORDERED_RE.exec(line);
    if (bullet || ordered !== null) {
      const isOrd = ordered !== null;
      const start = isOrd ? Number(ordered[1]) : 1;
      const items = [];
      while (i < L) {
        const ln = lines[i];
        if (isOrd) {
          const m = ORDERED_RE.exec(ln);
          if (m !== null) { items.push([trimL(m[2])]); i++; continue; }
        } else if ((ln[0] === '-' || ln[0] === '*') && ln[1] === ' ') {
          items.push([trimL(ln.slice(2))]); i++; continue;
        }
        let sp = 0;
        while (ln[sp] === ' ') sp++;
        if (sp >= 2 && sp < ln.length) { items[items.length - 1].push(trimL(ln)); i++; continue; }
        break;
      }
      const tag = isOrd ? 'ol' : 'ul';
      const open = isOrd && start !== 1 ? '<ol start="' + start + '">' : '<' + tag + '>';
      let s = open + '\n';
      for (const parts of items) s += '<li>' + inline(parts.join('\n'), link) + '</li>\n';
      blocks.push(s + '</' + tag + '>');
      continue;
    }
    const body = [trimL(line)];
    i++;
    while (i < L && !endsPara(lines[i])) body.push(trimL(lines[i++]));
    const html = inline(body.join('\n'), link);
    if (excerpt === null) excerpt = html;
    blocks.push('<p>' + html + '</p>');
  }
  return { html: blocks.length ? blocks.map((b) => b + '\n').join('') : '', toc, excerpt: excerpt ?? '' };
}

// ---- templates ----
const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INC_RE = /^include "([a-z0-9-]+)"$/;

class TemplateError extends Error {}

function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError('template "' + name + '": ' + JSON.stringify(text) + ' is not a path');
  return text.split('.');
}

function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) { text += src.slice(i); break; }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') { text += src.slice(i, open + 1); i = open + 1; continue; }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError('template "' + name + '": a ' + (raw ? '{{{' : '{{') + ' is not closed');
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError('template "' + name + '": a {% is not closed');
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
        body.push(node); stack.push(node); body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node); stack.push(node); body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError('template "' + name + '": an else outside an if');
        top.else = []; body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError('template "' + name + '": an ' + tag + ' with no open ' + tag.slice(3));
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INC_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError('template "' + name + '": {% ' + tag + ' %} is not a tag');
    }
  }
  if (stack.length > 1) throw new TemplateError('template "' + name + '": a ' + stack[stack.length - 1].kind + ' is not closed');
  return root.body;
}

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
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

function renderNodes(nodes, scope, templates, depth, out) {
  for (const n of nodes) {
    switch (n.kind) {
      case 'text': out.push(n.text); break;
      case 'var': out.push(escapeHtml(textOf(lookup(scope, n.path)))); break;
      case 'raw': out.push(textOf(lookup(scope, n.path))); break;
      case 'if': {
        const v = truthy(lookup(scope, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) renderNodes(branch, scope, templates, depth, out);
        break;
      }
      case 'for': {
        const xs = lookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        for (let k = 0; k < xs.length; k++) {
          const vars = { [n.name]: xs[k], loop: { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length } };
          renderNodes(n.body, { vars, parent: scope }, templates, depth, out);
        }
        break;
      }
      case 'include': {
        const t = templates.get(n.name);
        if (t !== undefined && depth < 8) renderNodes(t, scope, templates, depth + 1, out);
        break;
      }
    }
  }
}

// ---- build ----
function resolveRel(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { if (parts.length === 0) return null; parts.pop(); }
    else parts.push(seg);
  }
  return parts.join('/');
}
const dirOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;

function wordsOf(text) {
  const m = text.match(/\S+/g);
  return m === null ? 0 : m.length;
}

export function run(input) {
  const slugCache = new Map(); // per-case only: cleared by construction each run()
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(CMP)) {
    try { templates.set(name, parseTemplate(name, input.templates[name])); }
    catch (err) { if (!(err instanceof TemplateError)) throw err; report.push(err.message); }
  }
  const base = input.site.base_url.replace(/\/+$/, '');
  const files = [...input.files].sort((x, y) => CMP(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.replace(/\r\n?/g, '\n') });
    else statics.push(f);
  }
  const kept = [];
  for (const s of sources) {
    const fm = parseFM(s.text);
    if ('error' in fm) { report.push('refused ' + s.path + ': ' + fm.error); continue; }
    s.data = fm.data; s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = s.path.startsWith('tags/') ? 'tags' : s.path.startsWith('page/') ? 'page' : undefined;
    if (own !== undefined) { report.push('refused ' + s.path + ': ' + own + '/ is the generator\'s own'); continue; }
    if (s.post && !Object.hasOwn(s.data, 'date')) { report.push('refused ' + s.path + ': a post needs a date'); continue; }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) { report.push('refused ' + s.path + ': layout "' + layout + '" is no template that parses'); continue; }
    s.layout = layout;
    if (s.data.draft === true) { report.push('draft ' + s.path); continue; }
    kept.push(s);
  }
  const taken = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (!set) { set = new Set(dir === '' ? ['posts', 'tags', 'page'] : []); taken.set(dir, set); }
    s.slug = uniqueSlug(s.data.slug ?? slugify(s.data.title, slugCache), set);
    s.outDir = dir === '' ? s.slug : dir + '/' + s.slug;
    s.url = base + '/' + s.outDir + '/';
    bySource.set(s.path, s);
  }
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const link = (target) => {
      if (SCHEME_RE.test(target) || target[0] === '/' || target[0] === '#') return target;
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolveRel(dir, rel);
      if (path !== null && bySource.has(path)) return bySource.get(path).url + frag;
      if (path !== null && staticPaths.has(path)) return base + '/' + path + frag;
      broken.add('broken-link ' + s.path + ' -> ' + target);
      return target;
    };
    const md = renderMD(s.body, link, slugCache);
    s.html = md.html; s.toc = md.toc; s.excerpt = md.excerpt;
  }
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => CMP(y.data.date, x.data.date) || CMP(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of (s.data.tags ?? [])) {
      const sl = slugify(name, slugCache);
      if (!seen.has(sl)) { seen.add(sl); out.push(name); }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name, slugCache);
      let tag = bySlug.get(slug);
      if (!tag) { tag = { name, slug, url: base + '/tags/' + slug + '/', posts: [] }; bySlug.set(slug, tag); }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) if (!s.post) {
    s.tagRefs = ownTags(s).map((name) => {
      const sl = slugify(name, slugCache);
      return bySlug.get(sl) ?? { name, slug: sl, url: '', posts: [] };
    });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || CMP(x.slug, y.slug));
  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });
  const tagLinks = (s) => s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url }));
  const cards = new Map();
  for (const p of posts) {
    cards.set(p, {
      title: p.data.title, url: p.url, date: p.data.date ?? '',
      date_long: p.data.date === undefined ? '' : longDate(p.data.date),
      summary: p.data.summary ?? '', excerpt: p.excerpt,
      reading_minutes: Math.max(1, Math.ceil(wordsOf(p.body) / 200)),
      tags: tagLinks(p),
    });
  }
  const pageOf = (s) => {
    const c = cards.get(s) ?? {
      title: s.data.title, url: s.url, date: s.data.date ?? '',
      date_long: s.data.date === undefined ? '' : longDate(s.data.date),
      summary: s.data.summary ?? '', excerpt: s.excerpt,
      reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
      tags: tagLinks(s),
    };
    return { ...c, slug: s.slug, content: s.html, toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })), newer: linkOf(s.newer ?? null), older: linkOf(s.older ?? null), is_post: s.post };
  };
  const output = {};
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const render = (name, vars) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    const out = [];
    renderNodes(nodes, { vars: { site, tags: allTags, recent, ...vars }, parent: null }, templates, 0, out);
    return out.join('');
  };
  for (const s of kept) output[s.outDir + '/index.html'] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? base + '/' : base + '/page/' + k + '/');
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : 'page/' + k + '/index.html'] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) } });
    if (html !== null) output['tags/' + t.slug + '/index.html'] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push('shadowed ' + f.path + ': a built page has its path');
    else output[f.path] = f.content;
  }
  const lines = [...report, ...broken].sort(CMP);
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push('built ' + pageCount + ' pages, ' + posts.length + ' posts, ' + tags.length + ' tags and ' + statics.length + ' static files');
  output['build-report.txt'] = lines.join('\n') + '\n';
  return output;
}
