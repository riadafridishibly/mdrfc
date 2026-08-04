export type FmValue = string | number | boolean | null | FmValue[] | { [k: string]: FmValue };

export interface Frontmatter {
  /** Parsed key/value pairs; empty when the document has no frontmatter. */
  data: Record<string, FmValue>;
  /** Document body with the frontmatter block removed. */
  content: string;
  /** Raw frontmatter text (without delimiters), or "" when absent. */
  raw: string;
  /** Delimiter style detected: "yaml" (---), "toml" (+++), or null. */
  format: "yaml" | "toml" | null;
}

const FENCE = /^\uFEFF?(---|\+\+\+)[ \t]*\r?\n([\s\S]*?)(?:\r?\n)?^\1[ \t]*(?:\r?\n|$)/m;

/**
 * Split a document into frontmatter + body.
 * Supports YAML (`---`) and TOML (`+++`) fences at the very top of the file.
 * A document without a leading fence comes back unchanged with empty data.
 */
export function parseFrontmatter(src: string): Frontmatter {
  const m = FENCE.exec(src);
  if (!m || m.index !== 0) {
    return { data: {}, content: src, raw: "", format: null };
  }
  const [block, delim, raw] = m;
  const format = delim === "+++" ? "toml" : "yaml";
  const content = src.slice(block.length);
  let data: Record<string, FmValue>;
  try {
    data = format === "toml" ? parseToml(raw) : parseYaml(raw);
  } catch {
    // Malformed frontmatter should not blow up rendering; show the body only.
    data = {};
  }
  return { data, content, raw, format };
}

/** Flatten nested data to `key` / `key.sub` pairs with display-ready values. */
export function flattenFrontmatter(
  data: Record<string, FmValue>,
  prefix = ""
): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const [k, v] of Object.entries(data)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (isPlainObject(v)) out.push(...flattenFrontmatter(v, key));
    else out.push([key, formatValue(v)]);
  }
  return out;
}

/** Frontmatter title, when present, for use as the HTML document title. */
export function frontmatterTitle(data: Record<string, FmValue>): string | undefined {
  const t = data.title ?? data.Title;
  return typeof t === "string" && t.trim() ? t.trim() : undefined;
}

function isPlainObject(v: FmValue): v is { [k: string]: FmValue } {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function formatValue(v: FmValue): string {
  if (v === null) return "";
  if (Array.isArray(v)) return v.map(formatValue).join(", ");
  if (isPlainObject(v)) return flattenFrontmatter(v).map(([k, s]) => `${k}=${s}`).join(", ");
  return String(v).replace(/\s+$/, "");
}

// ── YAML (subset) ────────────────────────────────────────────────────

interface Cursor {
  i: number;
}

/**
 * Parse the commonly used YAML subset found in frontmatter: scalars, nested
 * maps, block and inline sequences, block scalars (`|`, `>`) and comments.
 * Anchors, tags, multi-document streams and flow-map nesting are not supported.
 */
function parseYaml(src: string): Record<string, FmValue> {
  const lines = src.split(/\r?\n/);
  const cur: Cursor = { i: 0 };
  const value = parseNode(lines, cur, 0);
  return isPlainObject(value) ? value : {};
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

function skippable(line: string): boolean {
  const t = line.trim();
  return !t || t.startsWith("#");
}

function parseNode(lines: string[], cur: Cursor, minIndent: number): FmValue {
  while (cur.i < lines.length && skippable(lines[cur.i])) cur.i++;
  if (cur.i >= lines.length) return null;
  const indent = indentOf(lines[cur.i]);
  if (indent < minIndent) return null;
  const t = lines[cur.i].trim();
  return t === "-" || t.startsWith("- ")
    ? parseSeq(lines, cur, indent)
    : parseMap(lines, cur, indent);
}

/** Does the next content line open a `-` item at exactly `indent`? */
function seqFollowsAt(lines: string[], cur: Cursor, indent: number): boolean {
  for (let i = cur.i; i < lines.length; i++) {
    if (skippable(lines[i])) continue;
    const t = lines[i].trim();
    return indentOf(lines[i]) === indent && (t === "-" || t.startsWith("- "));
  }
  return false;
}

function parseMap(lines: string[], cur: Cursor, indent: number): Record<string, FmValue> {
  const out: Record<string, FmValue> = {};
  while (cur.i < lines.length) {
    const line = lines[cur.i];
    if (skippable(line)) {
      cur.i++;
      continue;
    }
    const ind = indentOf(line);
    if (ind < indent) break;
    if (ind > indent) {
      cur.i++;
      continue;
    }
    const m = /^\s*("[^"]*"|'[^']*'|[^:#]+?)\s*:\s*(.*)$/.exec(line);
    if (!m) break;
    const key = unquote(m[1].trim());
    const rest = m[2];
    cur.i++;
    out[key] = parseValueAfterKey(lines, cur, indent, rest);
  }
  return out;
}

/** `|`/`>` with optional indentation indicator and chomping indicator. */
const BLOCK_HEADER = /^([|>])(\d*)([-+]?)[ \t]*(?:#.*)?$/;

function parseValueAfterKey(
  lines: string[],
  cur: Cursor,
  indent: number,
  rest: string
): FmValue {
  const head = rest.trim();
  const block = BLOCK_HEADER.exec(head);
  if (block) {
    return parseBlockScalar(lines, cur, indent, {
      fold: block[1] === ">",
      indent: block[2] ? indent + Number(block[2]) : -1,
      chomp: block[3],
    });
  }
  // Anchors are not resolved, but `key: &name` still introduces a nested node.
  if (head === "" || head.startsWith("#") || /^&\S+$/.test(head)) {
    // A block sequence is allowed to sit at its key's own indentation
    // (`tags:\n- a`); a nested map always has to be deeper.
    const nested = parseNode(lines, cur, seqFollowsAt(lines, cur, indent) ? indent : indent + 1);
    return nested ?? null;
  }
  return parseScalar(joinContinuation(lines, cur, indent, head));
}

/**
 * Absorb the continuation lines of a plain (or flow) scalar. YAML folds a
 * multi-line plain scalar onto one line, so more-indented following lines are
 * appended with a space. An unterminated `[`/`{`/quote keeps absorbing lines
 * regardless of indentation.
 */
function joinContinuation(
  lines: string[],
  cur: Cursor,
  indent: number,
  head: string
): string {
  let text = head;
  while (cur.i < lines.length) {
    const line = lines[cur.i];
    const open = isOpen(text);
    if (!open && (!line.trim() || indentOf(line) <= indent)) break;
    if (open && !line.trim()) {
      cur.i++;
      continue;
    }
    if (!open && BLOCK_HEADER.test(line.trim())) break;
    text += " " + line.trim();
    cur.i++;
  }
  return text;
}

interface BlockStyle {
  fold: boolean;
  /** Explicit content indent, or -1 to infer from the first content line. */
  indent: number;
  /** "" = clip, "-" = strip, "+" = keep trailing newlines. */
  chomp: string;
}

function parseBlockScalar(
  lines: string[],
  cur: Cursor,
  indent: number,
  style: BlockStyle
): string {
  const collected: string[] = [];
  let blockIndent = style.indent;
  while (cur.i < lines.length) {
    const line = lines[cur.i];
    if (line.trim() === "") {
      collected.push("");
      cur.i++;
      continue;
    }
    const ind = indentOf(line);
    if (ind <= indent) break;
    if (blockIndent < 0) blockIndent = ind;
    if (ind < blockIndent) break;
    collected.push(line.slice(blockIndent));
    cur.i++;
  }

  let trailing = 0;
  while (collected.length && collected[collected.length - 1] === "") {
    collected.pop();
    trailing++;
  }

  const body = style.fold ? fold(collected) : collected.join("\n");
  if (!body) return style.chomp === "+" ? "\n".repeat(trailing) : "";
  if (style.chomp === "-") return body;
  return body + (style.chomp === "+" ? "\n".repeat(trailing + 1) : "\n");
}

/** Folded (`>`) style: newlines inside a paragraph become spaces, blank lines break. */
function fold(lines: string[]): string {
  const paragraphs: string[][] = [[]];
  for (const line of lines) {
    if (line.trim() === "") paragraphs.push([]);
    else paragraphs[paragraphs.length - 1].push(line.trim());
  }
  return paragraphs
    .filter((p) => p.length)
    .map((p) => p.join(" "))
    .join("\n");
}

function parseSeq(lines: string[], cur: Cursor, indent: number): FmValue[] {
  const out: FmValue[] = [];
  while (cur.i < lines.length) {
    const line = lines[cur.i];
    if (skippable(line)) {
      cur.i++;
      continue;
    }
    const ind = indentOf(line);
    if (ind < indent) break;
    const t = line.trim();
    if (t !== "-" && !t.startsWith("- ")) break;
    const rest = t === "-" ? "" : t.slice(2).trim();
    cur.i++;
    if (!rest) {
      out.push(parseNode(lines, cur, indent + 1));
    } else if (/^("[^"]*"|'[^']*'|[^:#]+?)\s*:(\s|$)/.test(rest)) {
      // Sequence of maps: rewrite "- key: v" as an indented map line and reparse.
      cur.i--;
      lines[cur.i] = " ".repeat(indent + 2) + rest;
      out.push(parseMap(lines, cur, indent + 2));
    } else {
      out.push(parseScalar(joinContinuation(lines, cur, indent, rest)));
    }
  }
  return out;
}

function parseScalar(input: string): FmValue {
  const v = stripComment(input).trim();
  if (!v) return null;
  if (isQuoted(v)) return unquote(v);
  if (v.startsWith("[") && v.endsWith("]")) {
    return splitTopLevel(v.slice(1, -1)).map(parseScalar);
  }
  if (v.startsWith("{") && v.endsWith("}")) {
    const obj: Record<string, FmValue> = {};
    for (const pair of splitTopLevel(v.slice(1, -1))) {
      const idx = pair.indexOf(":");
      if (idx < 0) continue;
      obj[unquote(pair.slice(0, idx).trim())] = parseScalar(pair.slice(idx + 1));
    }
    return obj;
  }
  if (v === "true" || v === "false") return v === "true";
  if (v === "null" || v === "~") return null;
  if (/^-?(?:\d+|\d*\.\d+)(?:[eE][-+]?\d+)?$/.test(v)) return Number(v);
  return v;
}

function isQuoted(v: string): boolean {
  return (
    v.length >= 2 &&
    ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
  );
}

const ESCAPES: Record<string, string> = {
  n: "\n",
  t: "\t",
  r: "\r",
  b: "\b",
  f: "\f",
  "0": "\0",
  '"': '"',
  "\\": "\\",
  "/": "/",
};

function unquote(v: string): string {
  if (!isQuoted(v)) return v;
  const inner = v.slice(1, -1);
  if (v[0] === "'") return inner.replace(/''/g, "'");
  return inner.replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/g, (m, seq: string) => {
    if (seq[0] === "u" || seq[0] === "x") {
      return String.fromCodePoint(parseInt(seq.slice(1), 16));
    }
    return ESCAPES[seq] ?? seq;
  });
}

/** True while `s` ends inside an open quote or an unclosed `[`/`{`. */
function isOpen(s: string): boolean {
  const { depth, quote } = scan(s);
  return depth > 0 || quote !== "";
}

/** Single left-to-right pass tracking quote state, flow depth and comment start. */
function scan(s: string): { depth: number; quote: string; comment: number } {
  let depth = 0;
  let quote = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote === '"' && c === "\\") {
      i++;
      continue;
    }
    if (quote) {
      if (c === quote) quote = "";
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === "[" || c === "{") depth++;
    else if (c === "]" || c === "}") depth--;
    else if (c === "#" && (i === 0 || /\s/.test(s[i - 1]))) {
      return { depth, quote, comment: i };
    }
  }
  return { depth, quote, comment: -1 };
}

/** Drop a trailing ` # comment`, ignoring `#` inside quotes. */
function stripComment(s: string): string {
  const { comment } = scan(s);
  return comment < 0 ? s : s.slice(0, comment);
}

/** Split on commas that are not inside quotes, brackets or braces. */
function splitTopLevel(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote = "";
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote) quote = "";
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "[" || c === "{") depth++;
    else if (c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) {
      parts.push(s.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(s.slice(start));
  return parts.map((p) => p.trim()).filter((p) => p !== "");
}

// ── TOML (subset) ────────────────────────────────────────────────────

/**
 * Parse the TOML subset used by static-site frontmatter: `key = value`,
 * arrays, and `[table]` headers (including dotted names). Array-of-tables
 * (`[[x]]`) and multi-line arrays are not supported.
 */
function parseToml(src: string): Record<string, FmValue> {
  const root: Record<string, FmValue> = {};
  let table = root;
  for (const line of src.split(/\r?\n/)) {
    const t = stripComment(line).trim();
    if (!t) continue;
    const header = /^\[([^\]]+)\]$/.exec(t);
    if (header) {
      table = root;
      for (const part of header[1].split(".")) {
        const key = unquote(part.trim());
        const next = table[key];
        if (!isPlainObject(next)) table[key] = {};
        table = table[key] as Record<string, FmValue>;
      }
      continue;
    }
    const idx = t.indexOf("=");
    if (idx < 0) continue;
    table[unquote(t.slice(0, idx).trim())] = parseTomlValue(t.slice(idx + 1).trim());
  }
  return root;
}

function parseTomlValue(v: string): FmValue {
  if (isQuoted(v)) return unquote(v);
  if (v.startsWith("[") && v.endsWith("]")) {
    return splitTopLevel(v.slice(1, -1)).map(parseTomlValue);
  }
  if (v === "true" || v === "false") return v === "true";
  if (/^[-+]?(?:\d+|\d*\.\d+)(?:[eE][-+]?\d+)?$/.test(v)) return Number(v);
  return v;
}
