// Minimal dependency-free YAML subset parser.
// Supports: nested mappings, block/flow sequences, quoted scalars,
// block scalars (| |- |+ > >- >+), comments, and null/bool/number coercion.
// Deliberately NOT a full YAML implementation - it is validated on every
// build against all upstream SKILL.md frontmatter blocks, which fail loudly.

const CJK = /[⺀-鿿豈-﫿]/;

// Lines this parser could not interpret. Silently dropping them is how a
// hand-maintained config layer rots, so callers surface these as warnings.
let WARNINGS = [];
function warn(line, i) { WARNINGS.push(`line ${i + 1}: cannot parse \`${line.trim()}\``); }

function stripComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote && line[i - 1] !== '\\') quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i).replace(/\s+$/, '');
    }
  }
  return line.replace(/\s+$/, '');
}

function indentOf(line) {
  return line.length - line.replace(/^ */, '').length;
}

function parseScalar(raw) {
  const s = raw.trim();
  if (s === '' || s === '~' || s === 'null') return null;
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (/^-?\d+$/.test(s)) return Number(s);
  if (/^-?\d*\.\d+$/.test(s)) return Number(s);
  if (s.startsWith('"') && s.endsWith('"') && s.length > 1) {
    return s.slice(1, -1).replace(/\\"/g, '"').replace(/\\n/g, '\n');
  }
  if (s.startsWith("'") && s.endsWith("'") && s.length > 1) {
    return s.slice(1, -1).replace(/''/g, "'");
  }
  if (s.startsWith('[') && s.endsWith(']')) {
    const inner = s.slice(1, -1).trim();
    return inner ? splitFlow(inner).map((x) => parseScalar(x)) : [];
  }
  if (s.startsWith('{') && s.endsWith('}')) {
    const inner = s.slice(1, -1).trim();
    const obj = {};
    if (!inner) return obj;
    for (const part of splitFlow(inner)) {
      const at = findTopColon(part);
      if (at < 0) continue;
      obj[String(parseScalar(part.slice(0, at)))] = parseScalar(part.slice(at + 1));
    }
    return obj;
  }
  return s;
}

// Depth- and quote-aware comma split for flow collections.
function splitFlow(inner) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let cur = '';
  for (const c of inner) {
    if (quote) { cur += c; if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") { quote = c; cur += c; continue; }
    if (c === '[' || c === '{') depth++;
    if (c === ']' || c === '}') depth--;
    if (c === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim() !== '') parts.push(cur);
  return parts;
}

function findTopColon(s) {
  let depth = 0;
  let quote = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) { if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '[' || c === '{') depth++;
    if (c === ']' || c === '}') depth--;
    if (c === ':' && depth === 0 && (i + 1 >= s.length || /\s/.test(s[i + 1]))) return i;
  }
  return -1;
}

function readBlockScalar(lines, start, parentIndent, header) {
  const fold = header[0] === '>';
  const chomp = header.includes('-') ? 'strip' : header.includes('+') ? 'keep' : 'clip';
  const body = [];
  let i = start;
  let blockIndent = null;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') { body.push(''); continue; }
    const ind = indentOf(line);
    if (ind <= parentIndent) break;
    if (blockIndent === null) blockIndent = ind;
    body.push(line.slice(Math.min(blockIndent, ind)));
  }
  while (body.length && body[body.length - 1] === '') body.pop();
  let text;
  if (fold) {
    const out = [];
    for (const l of body) {
      if (l === '') out.push('\n');
      else if (out.length && out[out.length - 1] !== '\n') out.push(' ' + l);
      else out.push(l);
    }
    text = out.join('').replace(/\n /g, '\n');
  } else {
    text = body.join('\n');
  }
  if (chomp !== 'strip') text += '\n';
  return [text, i];
}

function parseBlock(lines, start, indent) {
  // Determine node kind from the first meaningful line at this indent.
  let i = start;
  while (i < lines.length && lines[i].trim() === '') i++;
  if (i >= lines.length) return [null, i];
  const isSeq = /^\s*-(\s|$)/.test(lines[i]);
  return isSeq ? parseSeq(lines, i, indent) : parseMap(lines, i, indent);
}

function parseSeq(lines, start, indent) {
  const out = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') { i++; continue; }
    const ind = indentOf(line);
    if (ind < indent) break;
    const m = line.match(/^\s*-\s*(.*)$/);
    if (ind > indent || !m) break;
    const rest = m[1];
    if (rest === '') {
      const [val, next] = parseBlock(lines, i + 1, indent + 2);
      out.push(val);
      i = next;
    } else if (/^[^\s:][^:]*:(\s|$)/.test(rest)) {
      // inline mapping start: re-parse as a map rooted at the dash column
      const pseudo = [' '.repeat(ind + 2) + rest, ...lines.slice(i + 1)];
      const [val, consumed] = parseMap(pseudo, 0, ind + 2);
      out.push(val);
      i = i + consumed; // consumed counts the rewritten first line too
    } else {
      out.push(parseScalar(rest));
      i++;
    }
  }
  return [out, i];
}

function parseMap(lines, start, indent) {
  const out = {};
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') { i++; continue; }
    const ind = indentOf(line);
    if (ind < indent) break;
    if (ind > indent) { warn(line, i); i++; continue; }
    const m = line.match(/^\s*("[^"]+"|'[^']+'|[^:]+):(?:\s+(.*))?$/);
    if (!m) { warn(line, i); i++; continue; }
    const key = String(parseScalar(m[1]));
    const rest = (m[2] ?? '').trim();
    if (/^[|>][-+]?\d*$/.test(rest)) {
      const [text, next] = readBlockScalar(lines, i + 1, ind, rest);
      out[key] = text;
      i = next;
    } else if (rest === '') {
      let j = i + 1;
      while (j < lines.length && lines[j].trim() === '') j++;
      if (j < lines.length && indentOf(lines[j]) > ind) {
        const [val, next] = parseBlock(lines, j, indentOf(lines[j]));
        out[key] = val;
        i = next;
      } else {
        out[key] = null;
        i++;
      }
    } else {
      out[key] = parseScalar(rest);
      i++;
    }
  }
  return [out, i];
}

export function parseYamlChecked(text) {
  WARNINGS = [];
  const lines = text.replace(/\r\n/g, '\n').split('\n').map(stripComment);
  const [val] = parseBlock(lines, 0, 0);
  return { value: val ?? {}, warnings: WARNINGS };
}

export function parseYaml(text) {
  return parseYamlChecked(text).value;
}

export function parseFrontmatterChecked(md) {
  const m = md.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return null;
  return parseYamlChecked(m[1]);
}

export function parseFrontmatter(md) {
  const r = parseFrontmatterChecked(md);
  return r ? r.value : null;
}

export function estTokens(s) {
  if (!s) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of s) (CJK.test(ch) ? cjk++ : other++);
  return Math.ceil(cjk * 1.05 + other / 3.8);
}
