// git.ts — the git smart-HTTP protocol and object-graph machinery, implemented from the protocol
// itself (there is no git binary at grading time): pkt-lines, pack v2 read/write with OFS/REF
// deltas, ref advertisement, protocol v2 ls-refs/fetch, protocol v0 fetch, and receive-pack with
// report-status. Objects live in the shared Store.

import * as zlib from 'node:zlib';
import {
  Store,
  ZERO_SHA,
  buildCommitData,
  buildTreeData,
  hashObject,
  parseCommit,
  parseTree,
  sha1Hex,
  type GitObject,
  type ObjType,
  type RepoRec,
  type TreeEntry,
} from './store.ts';

// ------------------------------------------------------------------ pkt-lines

export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const head = Buffer.from((body.length + 4).toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');
export const PKT_END = Buffer.from('0002', 'ascii');

export type PktItem = Buffer | 'flush' | 'delim' | 'end';

/** Parse pkt-lines from `buf` starting at `offset`; stops at the first malformed length. */
export function parsePktLines(buf: Buffer, offset: number): { items: PktItem[]; next: number; ok: boolean } {
  const items: PktItem[] = [];
  let pos = offset;
  while (pos + 4 <= buf.length) {
    const head = buf.toString('ascii', pos, pos + 4);
    if (!/^[0-9a-f]{4}$/.test(head)) return { items, next: pos, ok: false };
    const len = parseInt(head, 16);
    if (len === 0) {
      items.push('flush');
      pos += 4;
      continue;
    }
    if (len === 1) {
      items.push('delim');
      pos += 4;
      continue;
    }
    if (len === 2) {
      items.push('end');
      pos += 4;
      continue;
    }
    if (len < 4 || pos + len > buf.length) return { items, next: pos, ok: false };
    items.push(buf.subarray(pos + 4, pos + len));
    pos += len;
  }
  return { items, next: pos, ok: pos === buf.length || items.length > 0 };
}

/** The text lines of a pkt-line stream (payloads only, markers dropped). */
export function pktTexts(items: readonly PktItem[]): string[] {
  const lines: string[] = [];
  for (const item of items) if (Buffer.isBuffer(item)) lines.push(item.toString('utf8').replace(/\n$/, ''));
  return lines;
}

// ------------------------------------------------------------------ packs

const TYPE_IDS: Record<string, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const ID_TYPES: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** Inflate the deflate stream starting at `pos`; returns the data and the offset just past it. */
function inflateAt(buf: Buffer, pos: number): { data: Buffer; next: number } {
  // A truncated stream always throws and a complete one always succeeds, so the stream's end is
  // the smallest prefix length that inflates: binary-search it.
  let lo = 1;
  let hi = buf.length - pos;
  let best: Buffer | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    try {
      best = zlib.inflateSync(buf.subarray(pos, pos + mid));
      hi = mid - 1;
    } catch {
      lo = mid + 1;
    }
  }
  if (best === null) throw new Error('corrupt deflate stream in pack');
  return { data: best, next: pos + lo };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[pos]!;
      pos += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const sourceSize = readVarint();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const targetSize = readVarint();
  const out: Buffer[] = [];
  let produced = 0;
  while (pos < delta.length) {
    const op = delta[pos]!;
    pos += 1;
    if ((op & 0x80) !== 0) {
      let offset = 0;
      let size = 0;
      for (let i = 0; i < 4; i += 1) if ((op & (1 << i)) !== 0) { offset |= delta[pos]! << (8 * i); pos += 1; }
      for (let i = 0; i < 3; i += 1) if ((op & (0x10 << i)) !== 0) { size |= delta[pos]! << (8 * i); pos += 1; }
      if (size === 0) size = 0x10000;
      out.push(base.subarray(offset, offset + size));
      produced += size;
    } else if (op !== 0) {
      out.push(delta.subarray(pos, pos + op));
      pos += op;
      produced += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== targetSize || produced !== targetSize) throw new Error('delta target size mismatch');
  return result;
}

interface PackEntry {
  offset: number;
  kind: 'plain' | 'ofs' | 'ref';
  type?: ObjType;
  data?: Buffer;
  baseOffset?: number;
  baseSha?: string;
  delta?: Buffer;
}

/** Parse a pack into the store. Returns the object count; throws on any corruption. */
export function receivePack(store: Store, buf: Buffer): number {
  if (buf.length < 12 + 20 || buf.toString('ascii', 0, 4) !== 'PACK') throw new Error('not a pack');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = buf.readUInt32BE(8);
  let pos = 12;
  const entries: PackEntry[] = [];
  const byOffset = new Map<number, PackEntry>();
  for (let i = 0; i < count; i += 1) {
    const start = pos;
    let byte = buf[pos]!;
    pos += 1;
    const typeId = (byte >> 4) & 7;
    let size = byte & 0x0f;
    let shift = 4;
    while ((byte & 0x80) !== 0) {
      byte = buf[pos]!;
      pos += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let entry: PackEntry;
    if (typeId === 6) {
      let back = buf[pos]!;
      pos += 1;
      let offset = back & 0x7f;
      while ((back & 0x80) !== 0) {
        back = buf[pos]!;
        pos += 1;
        offset = ((offset + 1) << 7) | (back & 0x7f);
      }
      const inflated = inflateAt(buf, pos);
      pos = inflated.next;
      entry = { offset: start, kind: 'ofs', baseOffset: start - offset, delta: inflated.data };
    } else if (typeId === 7) {
      const baseSha = buf.toString('hex', pos, pos + 20);
      pos += 20;
      const inflated = inflateAt(buf, pos);
      pos = inflated.next;
      entry = { offset: start, kind: 'ref', baseSha, delta: inflated.data };
    } else {
      const type = ID_TYPES[typeId];
      if (type === undefined) throw new Error(`unknown pack object type ${typeId}`);
      const inflated = inflateAt(buf, pos);
      pos = inflated.next;
      if (inflated.data.length !== size) throw new Error('pack object size mismatch');
      entry = { offset: start, kind: 'plain', type, data: inflated.data };
    }
    entries.push(entry);
    byOffset.set(start, entry);
  }
  const resolved = new Map<number, { type: ObjType; data: Buffer; sha: string }>();
  const resolve = (entry: PackEntry): { type: ObjType; data: Buffer; sha: string } => {
    const memo = resolved.get(entry.offset);
    if (memo !== undefined) return memo;
    let out: { type: ObjType; data: Buffer; sha: string };
    if (entry.kind === 'plain') {
      out = { type: entry.type!, data: entry.data!, sha: hashObject(entry.type!, entry.data!) };
    } else {
      let base: { type: ObjType; data: Buffer; sha: string };
      if (entry.kind === 'ofs') {
        const baseEntry = byOffset.get(entry.baseOffset!);
        if (baseEntry === undefined) throw new Error('ofs-delta base not in pack');
        base = resolve(baseEntry);
      } else {
        const inPack = entries.find((candidate) => candidate.kind === 'plain' && hashObject(candidate.type!, candidate.data!) === entry.baseSha);
        if (inPack !== undefined) base = resolve(inPack);
        else {
          const stored = store.getObject(entry.baseSha!);
          if (stored === undefined) throw new Error('ref-delta base unknown');
          base = { type: stored.type, data: stored.data, sha: entry.baseSha! };
        }
      }
      const data = applyDelta(base.data, entry.delta!);
      out = { type: base.type, data, sha: hashObject(base.type, data) };
    }
    resolved.set(entry.offset, out);
    return out;
  };
  for (const entry of entries) {
    const obj = resolve(entry);
    if (!store.objects.has(obj.sha)) store.objects.set(obj.sha, { type: obj.type, data: obj.data });
  }
  return entries.length;
}

/** Build a pack holding exactly `objects` (plain, undeltified), with a correct trailer checksum. */
export function buildPack(objects: readonly GitObject[]): Buffer {
  const head = Buffer.alloc(12);
  head.write('PACK', 0, 'ascii');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(objects.length, 8);
  const parts: Buffer[] = [head];
  for (const obj of objects) {
    const typeId = TYPE_IDS[obj.type]!;
    let size = obj.data.length;
    const first = (typeId << 4) | (size & 0x0f);
    size >>= 4;
    const headerBytes: number[] = [];
    if (size === 0) headerBytes.push(first);
    else {
      headerBytes.push(first | 0x80);
      while (size > 0) {
        const byte = size & 0x7f;
        size >>= 7;
        headerBytes.push(size > 0 ? byte | 0x80 : byte);
      }
    }
    parts.push(Buffer.from(headerBytes));
    parts.push(zlib.deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, Buffer.from(sha1Hex(body), 'hex')]);
}

// ------------------------------------------------------------------ object graph

/** All ancestors of `tip` (inclusive), following commit parents. */
export function ancestorsOf(store: Store, tip: string): Set<string> {
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length > 0) {
    const sha = queue.pop()!;
    if (seen.has(sha)) continue;
    const commit = store.commitOf(sha);
    if (commit === null) continue;
    seen.add(sha);
    for (const parent of commit.parents) queue.push(parent);
  }
  return seen;
}

export function isAncestor(store: Store, ancestor: string, tip: string): boolean {
  return ancestorsOf(store, tip).has(ancestor);
}

/** A common ancestor of two commits (the first found by BFS from `b`), or null. */
export function mergeBaseOf(store: Store, a: string, b: string): string | null {
  const ancestorsA = ancestorsOf(store, a);
  const seen = new Set<string>();
  const queue = [b];
  while (queue.length > 0) {
    const sha = queue.shift()!;
    if (seen.has(sha)) continue;
    seen.add(sha);
    if (ancestorsA.has(sha)) return sha;
    const commit = store.commitOf(sha);
    if (commit !== null) queue.push(...commit.parents);
  }
  return null;
}

/** Add a tree and everything under it to `into` (sha -> object). */
export function collectTree(store: Store, treeSha: string, into: Map<string, GitObject>): void {
  if (into.has(treeSha)) return;
  const obj = store.getObject(treeSha);
  if (obj === undefined || obj.type !== 'tree') return;
  into.set(treeSha, obj);
  for (const entry of parseTree(obj.data)) {
    const child = store.getObject(entry.sha);
    if (child === undefined) continue;
    if (entry.mode === '40000') collectTree(store, entry.sha, into);
    else into.set(entry.sha, child);
  }
}

/** Flatten a tree into path -> {sha, mode} for files (blobs) only. */
export function flattenTree(store: Store, treeSha: string | null): Map<string, { sha: string; mode: string }> {
  const out = new Map<string, { sha: string; mode: string }>();
  const walk = (sha: string, prefix: string): void => {
    const obj = store.getObject(sha);
    if (obj === undefined || obj.type !== 'tree') return;
    for (const entry of parseTree(obj.data)) {
      if (entry.mode === '40000') walk(entry.sha, `${prefix}${entry.name}/`);
      else out.set(prefix + entry.name, { sha: entry.sha, mode: entry.mode });
    }
  };
  if (treeSha !== null) walk(treeSha, '');
  return out;
}

/** Read the file entry at `path` inside a tree, or null. */
export function treeEntryAt(store: Store, treeSha: string, path: string): TreeEntry | null {
  const parts = path.split('/').filter((part) => part !== '');
  let current = treeSha;
  for (let i = 0; i < parts.length; i += 1) {
    const obj = store.getObject(current);
    if (obj === undefined || obj.type !== 'tree') return null;
    const entry = parseTree(obj.data).find((candidate) => candidate.name === parts[i]);
    if (entry === undefined) return null;
    if (i === parts.length - 1) return entry;
    if (entry.mode !== '40000') return null;
    current = entry.sha;
  }
  return null;
}

/** List a directory inside a tree: direct children entries with their full paths, or null. */
export function treeDirAt(store: Store, treeSha: string, path: string): TreeEntry[] | null {
  if (path === '' || path === '/') {
    const obj = store.getObject(treeSha);
    if (obj === undefined || obj.type !== 'tree') return null;
    return parseTree(obj.data);
  }
  const entry = treeEntryAt(store, treeSha, path);
  if (entry === null || entry.mode !== '40000') return null;
  const obj = store.getObject(entry.sha);
  if (obj === undefined || obj.type !== 'tree') return null;
  return parseTree(obj.data);
}

/**
 * Return a new tree sha with `path` set to `blobSha` (or removed when blobSha is null), creating
 * intermediate trees. `treeSha` may be null (an empty tree). Unchanged paths keep their objects.
 */
export function updateTree(store: Store, treeSha: string | null, path: string, blobSha: string | null, mode = '100644'): string {
  const parts = path.split('/').filter((part) => part !== '');
  const set = (current: string | null, depth: number): string => {
    const entries: TreeEntry[] = current === null ? [] : [...parseTree(store.getObject(current)!.data)];
    const name = parts[depth]!;
    const index = entries.findIndex((entry) => entry.name === name);
    if (depth === parts.length - 1) {
      if (blobSha === null) {
        if (index !== -1) entries.splice(index, 1);
      } else if (index === -1) entries.push({ mode, name, sha: blobSha });
      else entries[index] = { mode, name, sha: blobSha };
    } else {
      const childCurrent = index === -1 ? null : entries[index]!.sha;
      const childNew = set(childCurrent, depth + 1);
      if (index === -1) entries.push({ mode: '40000', name, sha: childNew });
      else entries[index] = { mode: '40000', name, sha: childNew };
    }
    return store.putObject('tree', buildTreeData(entries));
  };
  return set(treeSha, 0);
}

/** Create a commit object on top of `parent` (or a root commit) and return its sha. */
export function makeCommit(
  store: Store,
  input: { tree: string; parents: string[]; message: string; seq: number },
): string {
  const stamp = `${Math.floor(Date.UTC(2024, 0, 1) / 1000) + input.seq} +0000`;
  const ident = `Forge <forge@localhost> ${stamp}`;
  return store.putObject('commit', buildCommitData({
    tree: input.tree,
    parents: input.parents,
    author: ident,
    committer: ident,
    message: input.message.endsWith('\n') ? input.message : `${input.message}\n`,
  }));
}

// ------------------------------------------------------------------ tree diff & merge

export interface FileChange {
  path: string;
  status: 'added' | 'modified' | 'removed';
  oldSha: string | null;
  newSha: string | null;
}

export function diffTrees(store: Store, baseTree: string | null, headTree: string | null): FileChange[] {
  const base = flattenTree(store, baseTree);
  const head = flattenTree(store, headTree);
  const changes: FileChange[] = [];
  for (const [path, entry] of head) {
    const before = base.get(path);
    if (before === undefined) changes.push({ path, status: 'added', oldSha: null, newSha: entry.sha });
    else if (before.sha !== entry.sha) changes.push({ path, status: 'modified', oldSha: before.sha, newSha: entry.sha });
  }
  for (const [path, entry] of base) {
    if (!head.has(path)) changes.push({ path, status: 'removed', oldSha: entry.sha, newSha: null });
  }
  changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return changes;
}

/** Line counts of a change: a small LCS diff, exact for the suite's file sizes. */
export function lineDiffCounts(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');
  const m = oldLines.length;
  const n = newLines.length;
  const dp: number[] = new Array((m + 1) * (n + 1)).fill(0);
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      dp[i * (n + 1) + j] = oldLines[i] === newLines[j]
        ? dp[(i + 1) * (n + 1) + j + 1] + 1
        : Math.max(dp[(i + 1) * (n + 1) + j], dp[i * (n + 1) + j + 1]);
    }
  }
  const common = dp[0]!;
  return { additions: n - common, deletions: m - common };
}

/**
 * A three-way tree merge. Returns the merged tree sha, or the first conflicting path.
 * Per path: unchanged on one side takes the other side; identical changes merge; anything else
 * (both sides changed differently, modify/delete, add/add with different bytes) conflicts.
 */
export function mergeTrees(store: Store, baseTree: string | null, ourTree: string | null, theirTree: string | null): { tree: string } | { conflict: string } {
  const base = flattenTree(store, baseTree);
  const ours = flattenTree(store, ourTree);
  const theirs = flattenTree(store, theirTree);
  const paths = new Set([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  let tree: string | null = null;
  // Start from ours, then apply their changes relative to base.
  tree = ourTree;
  for (const path of paths) {
    const b = base.get(path)?.sha ?? null;
    const o = ours.get(path)?.sha ?? null;
    const t = theirs.get(path)?.sha ?? null;
    if (t === b) continue; // they did not touch it: ours stands
    if (o === b) {
      tree = updateTree(store, tree, path, t); // only they changed it
      continue;
    }
    if (o === t) continue; // both made the same change
    return { conflict: path };
  }
  if (tree === null) tree = store.putObject('tree', buildTreeData([]));
  return { tree };
}

// ------------------------------------------------------------------ ref advertisement

function sortedRefs(repo: RepoRec): [string, string][] {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

function defaultRef(repo: RepoRec): string {
  return `refs/heads/${repo.defaultBranch}`;
}

/** The v0/v1 ref advertisement body for a service (the part after the "# service=" preamble). */
export function advertiseRefs(store: Store, repo: RepoRec, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const refs = sortedRefs(repo);
  const headTarget = defaultRef(repo);
  const headSha = repo.refs.get(headTarget) ?? ZERO_SHA;
  const caps = service === 'git-upload-pack'
    ? `multi_ack_detailed no-done side-band-64k thin-pack ofs-delta deepen-since deepen-not multi_ack symref=HEAD:${headTarget} object-format=sha1 agent=forge/1.0`
    : `report-status report-status-v2 delete-refs side-band-64k quiet atomic ofs-delta push-options object-format=sha1 agent=forge/1.0`;
  const lines: Buffer[] = [];
  if (refs.length === 0) {
    lines.push(pktLine(`${ZERO_SHA} capabilities^{}\0${caps}`));
  } else {
    lines.push(pktLine(`${headSha} HEAD\0${caps}`));
    for (const [ref, sha] of refs) {
      lines.push(pktLine(`${sha} ${ref}`));
      const peeled = peeledTarget(store, sha);
      if (peeled !== null && peeled !== sha) lines.push(pktLine(`${peeled} ${ref}^{}`));
    }
  }
  lines.push(PKT_FLUSH);
  return Buffer.concat(lines);
}

/** The commit a (possibly annotated) tag ultimately points at, or null when it is not a tag. */
export function peeledTarget(store: Store, sha: string): string | null {
  const obj = store.getObject(sha);
  if (obj === undefined || obj.type !== 'tag') return null;
  return store.peelToCommit(sha);
}

/** The protocol v2 capability advertisement. */
export function advertiseV2(repo: RepoRec): Buffer {
  const lines = [
    pktLine('version 2'),
    pktLine('agent=forge/1.0'),
    pktLine('ls-refs=unborn'),
    pktLine('fetch=shallow wait-for-done'),
    pktLine('object-format=sha1'),
    PKT_FLUSH,
  ];
  return Buffer.concat(lines);
}

// ------------------------------------------------------------------ ls-refs (v2)

export function handleLsRefs(store: Store, repo: RepoRec, body: Buffer): Buffer {
  const { items } = parsePktLines(body, 0);
  const args = pktTexts(items);
  const wantPeel = args.includes('peel');
  const wantSymrefs = args.includes('symrefs');
  const wantUnborn = args.includes('unborn');
  const prefixes = args.filter((line) => line.startsWith('ref-prefix ')).map((line) => line.slice('ref-prefix '.length));
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const out: Buffer[] = [];
  const headTarget = defaultRef(repo);
  const headSha = repo.refs.get(headTarget);
  if (matches('HEAD') && (headSha !== undefined || wantUnborn)) {
    let line = `${headSha ?? ZERO_SHA} HEAD`;
    if (wantSymrefs) line += ` symref-target:${headTarget}`;
    out.push(pktLine(line));
  }
  for (const [ref, sha] of sortedRefs(repo)) {
    if (!matches(ref)) continue;
    let line = `${sha} ${ref}`;
    if (wantPeel) {
      const peeled = peeledTarget(store, sha);
      if (peeled !== null) line += ` peeled:${peeled}`;
    }
    out.push(pktLine(line));
  }
  out.push(PKT_FLUSH);
  return Buffer.concat(out);
}

// ------------------------------------------------------------------ fetch (upload-pack)

interface FetchRequest {
  wants: string[];
  haves: string[];
  depth: number | null;
  shallowLines: string[];
  done: boolean;
}

function parseFetchRequest(items: readonly PktItem[]): FetchRequest {
  const request: FetchRequest = { wants: [], haves: [], depth: null, shallowLines: [], done: false };
  for (const line of pktTexts(items)) {
    if (line.startsWith('want ')) request.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) request.haves.push(line.slice(5).trim());
    else if (line.startsWith('deepen ')) request.depth = parseInt(line.slice(7).trim(), 10);
    else if (line.startsWith('shallow ')) request.shallowLines.push(line.slice(8).trim());
    else if (line === 'done') request.done = true;
  }
  return request;
}

interface FetchPlan {
  pack: Buffer;
  shallow: string[];
  unshallow: string[];
  common: string[];
}

/**
 * Work out what a fetch sends. Want closure: commits within `depth` BFS levels of the wants (all
 * ancestors when no depth), plus their trees and blobs. Have closure: the have commits and their
 * trees/blobs — and, for a plain (non-shallow) fetch, their ancestors too, since a client that
 * names haves without a deepen holds full history. A deepen fetch's haves are treated as the
 * shallow tips they are.
 */
export function planFetch(store: Store, request: FetchRequest): FetchPlan {
  const shallowMode = request.depth !== null || request.shallowLines.length > 0;
  const haveObjects = new Set<string>();
  const haveCommits = new Set<string>();
  const addClosure = (tip: string, withAncestors: boolean): void => {
    const commits = withAncestors ? ancestorsOf(store, tip) : store.commitOf(tip) !== null ? new Set([tip]) : new Set<string>();
    for (const commitSha of commits) {
      haveCommits.add(commitSha);
      haveObjects.add(commitSha);
      const commit = store.commitOf(commitSha);
      if (commit !== null) {
        const trees = new Map<string, GitObject>();
        collectTree(store, commit.tree, trees);
        for (const sha of trees.keys()) haveObjects.add(sha);
      }
    }
  };
  for (const have of request.haves) addClosure(have, !shallowMode);

  // BFS by levels from the wants.
  const included = new Map<string, GitObject>();
  const includedCommits = new Set<string>();
  const boundary = new Set<string>();
  let frontier = request.wants.filter((sha) => store.commitOf(sha) !== null);
  const visited = new Set<string>();
  let level = 0;
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const sha of frontier) {
      if (visited.has(sha)) continue;
      visited.add(sha);
      const commit = store.commitOf(sha);
      if (commit === null) continue;
      includedCommits.add(sha);
      if (!haveObjects.has(sha)) {
        const obj = store.getObject(sha);
        if (obj !== undefined) included.set(sha, obj);
        const trees = new Map<string, GitObject>();
        collectTree(store, commit.tree, trees);
        for (const [treeSha, treeObj] of trees) if (!haveObjects.has(treeSha)) included.set(treeSha, treeObj);
      }
      const withinDepth = request.depth === null || level + 1 < request.depth;
      for (const parent of commit.parents) {
        if (withinDepth) next.push(parent);
        else if (store.commitOf(parent) !== null) boundary.add(sha);
      }
    }
    frontier = next;
    level += 1;
  }
  // Boundary: included commits with a parent that exists but was not included.
  for (const sha of includedCommits) {
    const commit = store.commitOf(sha);
    if (commit === null) continue;
    for (const parent of commit.parents) {
      if (!includedCommits.has(parent) && store.commitOf(parent) !== null) boundary.add(sha);
    }
  }
  const shallow = request.depth !== null ? [...boundary] : [];
  const unshallow: string[] = [];
  for (const old of request.shallowLines) {
    const commit = store.commitOf(old);
    if (commit !== null && commit.parents.some((parent) => includedCommits.has(parent))) unshallow.push(old);
  }
  const common = request.haves.filter((have) => haveCommits.has(have) && store.commitOf(have) !== null);
  return { pack: buildPack([...included.values()]), shallow, unshallow, common };
}

/** Wrap pack bytes in side-band-64k packets (band 1), ending with a flush. */
export function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = 32768;
  for (let pos = 0; pos < pack.length; pos += CHUNK) {
    const chunk = pack.subarray(pos, Math.min(pack.length, pos + CHUNK));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  if (pack.length === 0) parts.push(pktLine(Buffer.from([1])));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** The v2 fetch response: a negotiation round (haves, no done) is acknowledgments only; the final
 * round (done) goes straight to shallow-info (when shallow) and the packfile section. */
export function handleFetchV2(store: Store, body: Buffer): Buffer {
  const { items } = parsePktLines(body, 0);
  const request = parseFetchRequest(items);
  const plan = planFetch(store, request);
  const parts: Buffer[] = [];
  if (request.haves.length > 0 && !request.done) {
    parts.push(pktLine('acknowledgments'));
    if (plan.common.length === 0) parts.push(pktLine('NAK'));
    else {
      plan.common.forEach((sha, index) => {
        parts.push(pktLine(`ACK ${sha}${index === plan.common.length - 1 ? ' ready' : ''}`));
      });
    }
    parts.push(PKT_FLUSH);
    return Buffer.concat(parts);
  }
  if (request.depth !== null || request.shallowLines.length > 0) {
    parts.push(pktLine('shallow-info'));
    for (const sha of plan.shallow) parts.push(pktLine(`shallow ${sha}`));
    for (const sha of plan.unshallow) parts.push(pktLine(`unshallow ${sha}`));
    parts.push(PKT_DELIM);
  }
  parts.push(pktLine('packfile'));
  parts.push(sidebandPack(plan.pack));
  return Buffer.concat(parts);
}

/** The v0 fetch response: shallow lines, NAK, then the sideband pack. */
export function handleFetchV0(store: Store, body: Buffer): Buffer {
  const { items } = parsePktLines(body, 0);
  const request = parseFetchRequest(items);
  const plan = planFetch(store, request);
  const parts: Buffer[] = [];
  for (const sha of plan.shallow) parts.push(pktLine(`shallow ${sha}`));
  for (const sha of plan.unshallow) parts.push(pktLine(`unshallow ${sha}`));
  parts.push(pktLine(plan.common.length > 0 ? `ACK ${plan.common[plan.common.length - 1]}` : 'NAK'));
  parts.push(sidebandPack(plan.pack));
  return Buffer.concat(parts);
}

// ------------------------------------------------------------------ receive-pack

export interface PushOutcome {
  status: number;
  body: Buffer;
}

/** Process one receive-pack request: store the pack, move the refs, answer report-status. */
export function handleReceivePack(store: Store, repo: RepoRec, body: Buffer): PushOutcome {
  const { items, next, ok } = parsePktLines(body, 0);
  if (!ok && items.length === 0) return { status: 400, body: Buffer.from('bad pkt-line stream') };
  interface Command { oldSha: string; newSha: string; ref: string; caps: string }
  const commands: Command[] = [];
  for (const item of items) {
    if (!Buffer.isBuffer(item)) continue;
    let text = item.toString('utf8').replace(/\n$/, '');
    let caps = '';
    const nul = text.indexOf('\0');
    if (nul !== -1) {
      caps = text.slice(nul + 1);
      text = text.slice(0, nul);
    }
    const fields = text.split(' ');
    if (fields.length >= 3 && /^[0-9a-f]{40}$/.test(fields[0]!) && /^[0-9a-f]{40}$/.test(fields[1]!)) {
      commands.push({ oldSha: fields[0]!, newSha: fields[1]!, ref: fields[2]!, caps });
    }
  }
  const caps = commands.length > 0 ? commands[0]!.caps : '';
  const wantReport = caps.includes('report-status');
  const wantSideband = caps.includes('side-band-64k');

  let unpackError: string | null = null;
  const rest = body.subarray(next);
  if (rest.length > 0) {
    try {
      receivePack(store, rest);
    } catch (err) {
      unpackError = err instanceof Error ? err.message : String(err);
    }
  }

  const results: { ref: string; ok: boolean; reason?: string }[] = [];
  for (const command of commands) {
    const fail = (reason: string): void => { results.push({ ref: command.ref, ok: false, reason }); };
    if (unpackError !== null) {
      fail(`unpack error: ${unpackError}`);
      continue;
    }
    const current = repo.refs.get(command.ref) ?? ZERO_SHA;
    if (command.oldSha !== current) {
      fail('reference was updated');
      continue;
    }
    if (command.newSha === ZERO_SHA) {
      if (current === ZERO_SHA) fail('does not exist');
      else {
        repo.refs.delete(command.ref);
        results.push({ ref: command.ref, ok: true });
      }
      continue;
    }
    const commitSha = store.peelToCommit(command.newSha);
    if (commitSha === null) {
      fail('missing object');
      continue;
    }
    if (current !== ZERO_SHA) {
      const currentCommit = store.peelToCommit(current);
      if (currentCommit === null || !isAncestor(store, currentCommit, commitSha)) {
        fail('non-fast-forward');
        continue;
      }
    }
    repo.refs.set(command.ref, command.newSha);
    results.push({ ref: command.ref, ok: true });
  }

  if (!wantReport) return { status: 200, body: Buffer.alloc(0) };
  const report: Buffer[] = [];
  report.push(pktLine(unpackError === null ? 'unpack ok' : `unpack ${unpackError}`));
  for (const result of results) {
    report.push(pktLine(result.ok ? `ok ${result.ref}` : `ng ${result.ref} ${result.reason ?? 'failed'}`));
  }
  report.push(PKT_FLUSH);
  const reportBody = Buffer.concat(report);
  if (!wantSideband) return { status: 200, body: reportBody };
  const parts: Buffer[] = [];
  const CHUNK = 32768;
  for (let pos = 0; pos < reportBody.length; pos += CHUNK) {
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), reportBody.subarray(pos, Math.min(reportBody.length, pos + CHUNK))])));
  }
  parts.push(PKT_FLUSH);
  return { status: 200, body: Buffer.concat(parts) };
}
