// store.ts — the forge's single in-memory store, shared by the git, REST, GraphQL and MCP surfaces.
// Git objects live content-addressed by SHA-1; repositories hold refs plus the issue/pull records the
// API surfaces create. Everything is in memory: the suite's workloads reward index lookups, not I/O.

import { createHash } from 'node:crypto';

export type ObjType = 'blob' | 'tree' | 'commit' | 'tag';
export interface GitObject {
  type: ObjType;
  data: Buffer;
}

export const ZERO_SHA = '0'.repeat(40);

export function sha1Hex(buf: Buffer): string {
  return createHash('sha1').update(buf).digest('hex');
}

/** The git object id of a typed payload: sha1("<type> <len>\0" + data). */
export function hashObject(type: ObjType, data: Buffer): string {
  const head = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1Hex(Buffer.concat([head, data]));
}

// ------------------------------------------------------------------ trees

export interface TreeEntry {
  mode: string; // '100644' | '100755' | '120000' | '40000' (tree)
  name: string;
  sha: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    const nul = data.indexOf(0x00, space);
    entries.push({
      mode: data.toString('utf8', pos, space),
      name: data.toString('utf8', space + 1, nul),
      sha: data.toString('hex', nul + 1, nul + 21),
    });
    pos = nul + 21;
  }
  return entries;
}

/** Serialize tree entries in git's order (directories sort as if their name ended in '/'). */
export function buildTreeData(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const an = a.name + (a.mode === '40000' ? '/' : '');
    const bn = b.name + (b.mode === '40000' ? '/' : '');
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.sha, 'hex'));
  }
  return Buffer.concat(parts);
}

// ------------------------------------------------------------------ commits

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let tree = '';
  let author = '';
  let committer = '';
  const parents: string[] = [];
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function buildCommitData(info: CommitInfo): Buffer {
  let head = `tree ${info.tree}\n`;
  for (const parent of info.parents) head += `parent ${parent}\n`;
  head += `author ${info.author}\ncommitter ${info.committer}\n\n`;
  return Buffer.from(head + info.message, 'utf8');
}

// ------------------------------------------------------------------ API records

export interface CommentRec {
  id: number;
  body: string;
  seq: number;
}

export interface IssueRec {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: CommentRec[];
  seq: number;
  closedSeq: number | null;
}

export interface PullRec {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  head: string;
  base: string;
  merged: boolean;
  mergedSeq: number | null;
  mergeCommitSha: string | null;
  seq: number;
}

export interface LabelRec {
  id: number;
  name: string;
  color: string;
  description: string | null;
}

export interface RepoRec {
  id: number;
  name: string;
  owner: string | null; // null until the token owner's login is learned from an owner-scoped path
  isPrivate: boolean;
  description: string;
  defaultBranch: string;
  refs: Map<string, string>; // full ref name ('refs/heads/main') -> commit sha
  issues: Map<number, IssueRec>;
  pulls: Map<number, PullRec>;
  nextNumber: number; // issues and pull requests share one per-repo counter, as on GitHub
  labels: Map<string, LabelRec>;
  seq: number;
}

const EPOCH_BASE_MS = Date.UTC(2024, 0, 1, 0, 0, 0);

export class Store {
  readonly objects = new Map<string, GitObject>();
  readonly repos = new Map<number, RepoRec>();
  private readonly repoByKey = new Map<string, RepoRec>(); // "<owner>/<name>" once the owner is bound
  private unowned: RepoRec[] = [];
  boundOwner: string | null = null;
  readonly token: string = process.env.MAKEFUN_SHOP_TOKEN ?? '';

  private repoIdCounter = 0;
  private issueIdCounter = 100_000;
  private commentIdCounter = 0;
  private labelIdCounter = 0;
  private seqCounter = 0;

  /** A monotone sequence number; also the clock: timestamps derive from it so ordering is exact. */
  nextSeq(): number {
    this.seqCounter += 1;
    return this.seqCounter;
  }

  isoOf(seq: number): string {
    return new Date(EPOCH_BASE_MS + seq * 1000).toISOString();
  }

  nowIso(): string {
    return this.isoOf(this.seqCounter);
  }

  nextIssueId(): number {
    this.issueIdCounter += 1;
    return this.issueIdCounter;
  }

  nextCommentId(): number {
    this.commentIdCounter += 1;
    return this.commentIdCounter;
  }

  nextLabelId(): number {
    this.labelIdCounter += 1;
    return this.labelIdCounter;
  }

  // -------------------------------------------------------------- git objects

  putObject(type: ObjType, data: Buffer): string {
    const sha = hashObject(type, data);
    if (!this.objects.has(sha)) this.objects.set(sha, { type, data });
    return sha;
  }

  getObject(sha: string): GitObject | undefined {
    return this.objects.get(sha);
  }

  /** Resolve a commit-ish object (commit, or a tag pointing at one) to its commit sha. */
  peelToCommit(sha: string): string | null {
    let current = sha;
    for (let depth = 0; depth < 16; depth += 1) {
      const obj = this.objects.get(current);
      if (obj === undefined) return null;
      if (obj.type === 'commit') return current;
      if (obj.type === 'tag') {
        const match = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8'));
        if (match === null) return null;
        current = match[1]!;
        continue;
      }
      return null;
    }
    return null;
  }

  commitOf(sha: string): CommitInfo | null {
    const commitSha = this.peelToCommit(sha);
    if (commitSha === null) return null;
    const obj = this.objects.get(commitSha);
    if (obj === undefined || obj.type !== 'commit') return null;
    return parseCommit(obj.data);
  }

  // -------------------------------------------------------------- repositories

  /**
   * Learn the token owner's login from the first owner-scoped path that names it. The forge is
   * single-tenant (one shop token), and the API creates repositories without an owner in the path,
   * so the login is bound lazily; repositories created before the binding adopt it.
   */
  bindOwner(owner: string): void {
    if (this.boundOwner !== null || owner === '') return;
    this.boundOwner = owner;
    for (const repo of this.unowned) {
      repo.owner = owner;
      this.repoByKey.set(`${owner}/${repo.name}`, repo);
    }
    this.unowned = [];
  }

  createRepo(name: string, isPrivate: boolean, description: string): RepoRec | null {
    const owner = this.boundOwner;
    if (owner !== null && this.repoByKey.has(`${owner}/${name}`)) return null;
    if (owner === null && this.unowned.some((repo) => repo.name === name)) return null;
    this.repoIdCounter += 1;
    const repo: RepoRec = {
      id: this.repoIdCounter,
      name,
      owner,
      isPrivate,
      description,
      defaultBranch: 'main',
      refs: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
      labels: new Map(),
      seq: this.nextSeq(),
    };
    this.repos.set(repo.id, repo);
    if (owner === null) this.unowned.push(repo);
    else this.repoByKey.set(`${owner}/${name}`, repo);
    return repo;
  }

  /** Find a repository by owner/name, binding the owner on first sight. Null when it is not ours. */
  findRepo(owner: string, name: string): RepoRec | null {
    this.bindOwner(owner);
    if (this.boundOwner !== owner) return null;
    return this.repoByKey.get(`${owner}/${name}`) ?? null;
  }

  repoById(id: number): RepoRec | undefined {
    return this.repos.get(id);
  }

  /** Every repository the token owns (bound or not yet bound), in creation order. */
  allRepos(): RepoRec[] {
    return [...this.repos.values()].sort((a, b) => a.id - b.id);
  }

  deleteRepo(repo: RepoRec): void {
    this.repos.delete(repo.id);
    if (repo.owner !== null) this.repoByKey.delete(`${repo.owner}/${repo.name}`);
    this.unowned = this.unowned.filter((entry) => entry !== repo);
  }

  /** The login to render as a repository's owner (the bound login once known). */
  ownerOf(repo: RepoRec): string {
    return repo.owner ?? this.boundOwner ?? '';
  }
}
