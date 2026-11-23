// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

/** What an edit may record while it runs: strict matching and moves for `R` lines. */
interface Ctx {
  strict: boolean;
  moves: Array<[string, string]>;
}
type Edit = (tree: Tree, ctx: Ctx) => void;

/** A file's lines, its line break and whether it ends with one (SPEC.md section 3). */
function fileBreak(text: string): '\r\n' | '\n' {
  const i = text.indexOf('\n');
  return i > 0 && text[i - 1] === '\r' ? '\r\n' : '\n';
}
interface Split {
  lines: string[];
  endsWithBreak: boolean;
  br: '\r\n' | '\n';
}
function splitFile(text: string): Split {
  if (text === '') return { lines: [], endsWithBreak: false, br: '\n' };
  const br = fileBreak(text);
  const endsWithBreak = text.endsWith(br);
  const pieces = text.split(br);
  if (endsWithBreak) pieces.pop();
  return { lines: pieces, endsWithBreak, br };
}
function joinFile(lines: string[], endsWithBreak: boolean, br: string): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (endsWithBreak ? br : '');
}
function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}
/** A line as a tier reads it (SPEC.md section 5). */
function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}
function tiers(strict: boolean): number[] {
  return strict ? [0] : [0, 1, 2];
}
/** Every position at or after `from` where O matches the file's lines at a tier. */
function occurrences(lines: string[], o: string[], tier: number, from: number, eofOnly: boolean): number[] {
  const want = o.map((l) => normLine(l, tier));
  const out: number[] = [];
  for (let i = from; i + o.length <= lines.length; i += 1) {
    if (eofOnly && i + o.length !== lines.length) continue;
    let ok = true;
    for (let j = 0; j < o.length; j += 1) {
      if (normLine(lines[i + j]!, tier) !== want[j]) { ok = false; break; }
    }
    if (ok) out.push(i);
  }
  return out;
}
/** The first tier at which O occurs at or after `from`, with its positions. */
function findTier(lines: string[], o: string[], from: number, strict: boolean, eofOnly: boolean): { tier: number; positions: number[] } | null {
  for (const t of tiers(strict)) {
    const pos = occurrences(lines, o, t, from, eofOnly);
    if (pos.length > 0) return { tier: t, positions: pos };
  }
  return null;
}
/** The occurrence nearest to `target` at the tier where O is found (ties: the earlier). */
function findNearest(lines: string[], o: string[], target: number, strict: boolean): { pos: number; tier: number } | null {
  const found = findTier(lines, o, 0, strict, false);
  if (found === null) return null;
  let best = found.positions[0]!;
  let bestDist = Math.abs(best - target);
  for (const p of found.positions) {
    const d = Math.abs(p - target);
    if (d < bestDist) { best = p; bestDist = d; }
  }
  return { pos: best, tier: found.tier };
}
/** The first line at or after `from` equal to a single line, at the first tier with one. */
function findSingleLine(lines: string[], anchor: string, from: number, strict: boolean): number | null {
  for (const t of tiers(strict)) {
    const want = normLine(anchor, t);
    for (let i = from; i < lines.length; i += 1) {
      if (normLine(lines[i]!, t) === want) return i;
    }
  }
  return null;
}
type NewLine = { text: string; ctxIdx: number | null };
/** The lines that replace a match: context lines as the file's own, the rest re-indented at tier 2. */
function buildReplacement(fileLines: string[], pos: number, o: string[], n: NewLine[], tier: number): string[] {
  const p = leadingWs(o[0]!);
  const f = leadingWs(fileLines[pos]!);
  return n.map((item) => {
    if (item.ctxIdx !== null) return fileLines[pos + item.ctxIdx]!;
    const t = item.text;
    if (tier === 2 && t !== '' && /[^ \t]/.test(t) && t.startsWith(p)) return f + t.slice(p.length);
    return t;
  });
}
/** A move chain's origin: the path a moved file had before the patch. */
function composeMoves(moves: Array<[string, string]>): Map<string, string> {
  const origin = new Map<string, string>();
  for (const [o, n] of moves) {
    const orig = origin.get(o) ?? o;
    origin.delete(o);
    origin.set(n, orig);
  }
  return origin;
}

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** A hunk or chunk body read into old lines O and new lines N (SPEC.md sections 5 and 6). */
interface Body {
  o: string[];
  n: NewLine[];
  /** a `\` line follows the hunk's last context or `+` line */
  backslashAfterLast: boolean;
  /** a `\` line follows the hunk's last `+` line */
  backslashAfterLastPlus: boolean;
}
function parseBody(body: string[]): Body {
  const o: string[] = [];
  const n: NewLine[] = [];
  const bsAfter: boolean[] = [];
  let lastN = -1;
  let lastPlus = -1;
  for (const l of body) {
    if (l === '' || l.startsWith(' ')) {
      const t = l === '' ? '' : l.slice(1);
      o.push(t);
      n.push({ text: t, ctxIdx: o.length - 1 });
      bsAfter.push(false);
      lastN = n.length - 1;
    } else if (l.startsWith('-')) {
      o.push(l.slice(1));
      lastN = -1;
    } else if (l.startsWith('+')) {
      n.push({ text: l.slice(1), ctxIdx: null });
      bsAfter.push(false);
      lastN = n.length - 1;
      lastPlus = n.length - 1;
    } else if (l.startsWith('\\')) {
      if (lastN >= 0) bsAfter[lastN] = true;
      lastN = -1;
    }
  }
  return {
    o,
    n,
    backslashAfterLast: n.length > 0 ? bsAfter[n.length - 1]! : false,
    backslashAfterLastPlus: lastPlus >= 0 ? bsAfter[lastPlus]! : false,
  };
}

interface Hunk {
  a: number;
  body: Body;
}
interface Section {
  pairOld: string | null;
  pairNew: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  diffOld: string | null;
  diffNew: string | null;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}
/** A leading `a/` or `b/` is removed from a unified header path. */
function stripPrefix(p: string): string {
  return p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p;
}
/** A `--- ` / `+++ ` path: the text after the four characters, up to the first tab, trimmed. */
function headerPath(line: string): string {
  const rest = line.slice(4);
  const tab = rest.indexOf('\t');
  return (tab >= 0 ? rest.slice(0, tab) : rest).trim();
}
const HUNK_HEAD = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
function diffGitPaths(line: string): [string, string] | null {
  const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
  if (m === null) return null;
  return [m[1]!, m[2]!.trimEnd()];
}
/** The old and new path a unified section names, in the order the spec gives. */
function sectionPaths(s: Section): { oldP: string | null; newP: string | null } {
  return { oldP: s.pairOld ?? s.renameFrom ?? s.diffOld, newP: s.pairNew ?? s.renameTo ?? s.diffNew };
}
/** The hunks of a section, applied in order to a file's text (SPEC.md section 6). */
function applyHunks(before: string, hunks: Hunk[], strict: boolean, path: string): string {
  const split = splitFile(before);
  const lines = split.lines;
  let endsWithBreak = split.endsWithBreak;
  const br = split.br;
  let d = 0;
  for (const hunk of hunks) {
    const { o, n, backslashAfterLast } = hunk.body;
    if (o.length === 0) {
      const at = Math.max(0, Math.min(hunk.a + d, lines.length));
      const atEnd = at === lines.length;
      lines.splice(at, 0, ...n.map((x) => x.text));
      if (atEnd) endsWithBreak = !backslashAfterLast;
      d += n.length;
      continue;
    }
    const found = findNearest(lines, o, hunk.a - 1 + d, strict);
    if (found === null) throw new Fail('no-match', path);
    const replacement = buildReplacement(lines, found.pos, o, n, found.tier);
    const ranToEnd = found.pos + o.length === lines.length;
    lines.splice(found.pos, o.length, ...replacement);
    if (ranToEnd) endsWithBreak = !backslashAfterLast;
    d += n.length - o.length;
  }
  return joinFile(lines, endsWithBreak, br);
}
function unifiedSectionEdit(sec: Section): Edit {
  return (tree, ctx) => {
    const { oldP, newP } = sectionPaths(sec);
    if (sec.newFile || oldP === '/dev/null' || oldP === null) {
      if (newP === null || newP === '/dev/null') throw new Fail('unsafe', '/dev/null');
      if (!safe(newP)) throw new Fail('unsafe', newP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const plus: string[] = [];
      let bsLastPlus = false;
      for (const hunk of sec.hunks) {
        let hasPlus = false;
        for (const item of hunk.body.n) {
          if (item.ctxIdx === null) { plus.push(item.text); hasPlus = true; }
        }
        if (hasPlus) bsLastPlus = hunk.body.backslashAfterLastPlus;
      }
      tree.now.set(newP, plus.length === 0 ? '' : plus.join('\n') + (bsLastPlus ? '' : '\n'));
      return;
    }
    if (sec.deletedFile || newP === '/dev/null') {
      if (oldP === null || oldP === '/dev/null') throw new Fail('missing', '/dev/null');
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    if (!safe(oldP)) throw new Fail('unsafe', oldP);
    if (!safe(newP)) throw new Fail('unsafe', newP);
    const before = tree.get(oldP);
    if (before === null) throw new Fail('missing', oldP);
    if (oldP !== newP && tree.get(newP) !== null) throw new Fail('exists', newP);
    const out = applyHunks(before, sec.hunks, ctx.strict, oldP);
    if (oldP === newP) {
      tree.now.set(oldP, out);
      return;
    }
    tree.now.set(newP, out);
    tree.now.set(oldP, null);
    ctx.moves.push([oldP, newP]);
  };
}
/** The unified sections of a patch, each one edit (SPEC.md section 6). */
function unifiedEdits(lines: string[]): Edit[] {
  const sections: Section[] = [];
  const fresh = (): Section => ({ pairOld: null, pairNew: null, renameFrom: null, renameTo: null, diffOld: null, diffNew: null, newFile: false, deletedFile: false, hunks: [] });
  let cur: Section | null = null;
  let inHeader = false;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const paths = diffGitPaths(line);
      if (paths === null) throw new Exit2(`error: parse ${i + 1}`);
      if (cur !== null) sections.push(cur);
      cur = fresh();
      cur.diffOld = paths[0];
      cur.diffNew = paths[1];
      inHeader = true;
      i += 1;
      continue;
    }
    if (line.startsWith('--- ')) {
      const next = lines[i + 1] ?? '';
      if (next.startsWith('+++ ')) {
        if (cur !== null && inHeader) {
          cur.pairOld = stripPrefix(headerPath(line));
          cur.pairNew = stripPrefix(headerPath(next));
        } else {
          if (cur !== null) sections.push(cur);
          cur = fresh();
          cur.pairOld = stripPrefix(headerPath(line));
          cur.pairNew = stripPrefix(headerPath(next));
          inHeader = true;
        }
        i += 2;
        continue;
      }
      if (cur !== null && inHeader) throw new Exit2(`error: parse ${i + 2}`);
      i += 1;
      continue;
    }
    if (line.startsWith('+++ ') && cur !== null && inHeader) {
      cur.pairNew = stripPrefix(headerPath(line));
      i += 1;
      continue;
    }
    const hm = HUNK_HEAD.exec(line);
    if (hm !== null) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const body: string[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const l = lines[j]!;
        if (l.startsWith('diff --git ')) break;
        if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l.startsWith('\\')) { body.push(l); j += 1; continue; }
        break;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      cur.hunks.push({ a: Number(hm[1]), body: parseBody(body) });
      inHeader = false;
      i = j;
      continue;
    }
    if (line.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
    if (cur !== null && inHeader) {
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice('rename to '.length).trim();
      else if (line === 'new file mode' || line.startsWith('new file mode ')) cur.newFile = true;
      else if (line === 'deleted file mode' || line.startsWith('deleted file mode ')) cur.deletedFile = true;
      i += 1;
      continue;
    }
    i += 1;
  }
  if (cur !== null) sections.push(cur);
  return sections.map(unifiedSectionEdit);
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** One SEARCH/REPLACE block (SPEC.md section 7). */
function searchReplaceEdit(path: string, o: string[], n: string[]): Edit {
  return (tree, ctx) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (o.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, n.length === 0 ? '' : n.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const split = splitFile(before);
    const found = findTier(split.lines, o, 0, ctx.strict, false);
    if (found === null) throw new Fail('no-match', path);
    if (found.positions.length > 1) throw new Fail('ambiguous', path);
    const pos = found.positions[0]!;
    const replacement = buildReplacement(split.lines, pos, o, n.map((t) => ({ text: t, ctxIdx: null })), found.tier);
    split.lines.splice(pos, o.length, ...replacement);
    tree.now.set(path, joinFile(split.lines, split.endsWithBreak, split.br));
  };
}
/** The SEARCH/REPLACE blocks of a patch, each one edit (SPEC.md section 7). */
function searchReplaceEdits(lines: string[]): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let prevEnd = 0;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') { i += 1; continue; }
    const searchIdx = i;
    let path: string | null = null;
    for (let j = searchIdx - 1; j >= prevEnd; j -= 1) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
      path = prevPath;
    }
    let eq = -1;
    for (let j = searchIdx + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') { eq = j; break; }
    }
    if (eq === -1) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') { rep = j; break; }
    }
    if (rep === -1) throw new Exit2(`error: parse ${searchIdx + 1}`);
    edits.push(searchReplaceEdit(path, lines.slice(searchIdx + 1, eq), lines.slice(eq + 1, rep)));
    prevPath = path;
    prevEnd = rep + 1;
    i = rep + 1;
  }
  return edits;
}

interface Chunk {
  anchor: string | null;
  body: Body;
  eof: boolean;
}
function isV4aSectionStart(line: string): boolean {
  return line.startsWith('*** Add File: ') || line.startsWith('*** Delete File: ') || line.startsWith('*** Update File: ');
}
/** One V4A section (SPEC.md section 8). */
function v4aSectionEdit(kind: string, path: string, moveTo: string | null, chunks: Chunk[], addLines: string[] = []): Edit {
  return (tree, ctx) => {
    if (kind === 'add') {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, addLines.length === 0 ? '' : addLines.join('\n') + '\n');
      return;
    }
    if (kind === 'delete') {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) === null) throw new Fail('missing', path);
      tree.now.set(path, null);
      return;
    }
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const split = splitFile(before);
    const lines = split.lines;
    let cursor = 0;
    for (const chunk of chunks) {
      if (chunk.anchor !== null) {
        const at = findSingleLine(lines, chunk.anchor, cursor, ctx.strict);
        if (at === null) throw new Fail('no-match', path);
        cursor = at + 1;
      }
      const { o, n } = chunk.body;
      if (o.length === 0) {
        const at = chunk.eof ? lines.length : cursor;
        lines.splice(at, 0, ...n.map((x) => x.text));
        cursor = at + n.length;
        continue;
      }
      const found = findTier(lines, o, cursor, ctx.strict, chunk.eof);
      if (found === null) throw new Fail('no-match', path);
      const pos = found.positions[0]!;
      const replacement = buildReplacement(lines, pos, o, n, found.tier);
      lines.splice(pos, o.length, ...replacement);
      cursor = pos + replacement.length;
    }
    const out = joinFile(lines, split.endsWithBreak, split.br);
    if (moveTo !== null) {
      tree.now.set(moveTo, out);
      tree.now.set(path, null);
      ctx.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, out);
    }
  };
}
/** The V4A sections of a patch, each one edit (SPEC.md section 8). */
function v4aEdits(lines: string[]): Edit[] {
  if (lines.length === 0) throw new Exit2('error: parse 1');
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k -= 1) {
    if (!blank(lines[k]!)) { last = k; break; }
  }
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) { i += 1; continue; }
    if (line.startsWith('*** Add File: ')) {
      const path = line.slice('*** Add File: '.length).trim();
      const secLines: Array<{ text: string; num: number }> = [];
      i += 1;
      while (i < last && !isV4aSectionStart(lines[i]!)) { secLines.push({ text: lines[i]!, num: i + 1 }); i += 1; }
      while (secLines.length > 0 && blank(secLines[secLines.length - 1]!.text)) secLines.pop();
      for (const sl of secLines) {
        if (sl.text !== '' && !sl.text.startsWith('+')) throw new Exit2(`error: parse ${sl.num}`);
      }
      const chunk: Chunk = { anchor: null, body: parseBody(secLines.map((sl) => sl.text)), eof: false };
      const fileLines: string[] = secLines.map((sl) => (sl.text === '' ? '' : sl.text.slice(1)));
      edits.push(v4aSectionEdit('add', path, null, [chunk], fileLines));
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      const path = line.slice('*** Delete File: '.length).trim();
      i += 1;
      while (i < last && !isV4aSectionStart(lines[i]!)) {
        if (!blank(lines[i]!)) throw new Exit2(`error: parse ${i + 1}`);
        i += 1;
      }
      edits.push(v4aSectionEdit('delete', path, null, []));
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const path = line.slice('*** Update File: '.length).trim();
      const updateNum = i + 1;
      i += 1;
      let moveTo: string | null = null;
      if (i < last && lines[i]!.startsWith('*** Move to: ')) {
        moveTo = lines[i]!.slice('*** Move to: '.length).trim();
        i += 1;
      }
      const secLines: Array<{ text: string; num: number }> = [];
      while (i < last && !isV4aSectionStart(lines[i]!)) { secLines.push({ text: lines[i]!, num: i + 1 }); i += 1; }
      while (secLines.length > 0 && blank(secLines[secLines.length - 1]!.text)) secLines.pop();
      const chunks: Chunk[] = [];
      let cur: { anchor: string | null; body: string[]; eof: boolean } | null = null;
      let chunkCount = 0;
      for (const sl of secLines) {
        const text = sl.text;
        if (text.startsWith('@@')) {
          if (cur !== null) chunks.push({ anchor: cur.anchor, body: parseBody(cur.body), eof: cur.eof });
          const a = text.slice(2).trim();
          cur = { anchor: a === '' ? null : a, body: [], eof: false };
          chunkCount += 1;
        } else if (text === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${sl.num}`);
          cur.eof = true;
          chunks.push({ anchor: cur.anchor, body: parseBody(cur.body), eof: true });
          cur = null;
        } else if (text === '' || text.startsWith(' ') || text.startsWith('-') || text.startsWith('+')) {
          if (cur === null) {
            if (chunkCount > 0) throw new Exit2(`error: parse ${sl.num}`);
            cur = { anchor: null, body: [], eof: false };
            chunkCount += 1;
          }
          cur.body.push(text);
        } else {
          throw new Exit2(`error: parse ${sl.num}`);
        }
      }
      if (cur !== null) chunks.push({ anchor: cur.anchor, body: parseBody(cur.body), eof: cur.eof });
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateNum}`);
      edits.push(v4aSectionEdit('update', path, moveTo, chunks));
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits = kind === 'json' ? jsonEdits(text, lines) : kind === 'unified' ? unifiedEdits(lines) : kind === 'search-replace' ? searchReplaceEdits(lines) : v4aEdits(lines);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const ctx: Ctx = { strict, moves: [] };
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree, ctx);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const origin = composeMoves(ctx.moves);
  const rows: Array<{ key: string; line: string }> = [];
  const covered = new Set<string>();
  for (const [dest, orig] of origin) {
    if (orig === dest) continue;
    if (tree.original(dest) === null && tree.get(dest) !== null && tree.original(orig) !== null && tree.get(orig) === null) {
      rows.push({ key: dest, line: `R ${orig} -> ${dest}` });
      covered.add(dest);
      covered.add(orig);
    }
  }
  for (const p of [...tree.now.keys()]) {
    if (covered.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const outLines = rows.map((r) => r.line);
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...outLines, `ok: ${outLines.length} ${outLines.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
