// rest.ts — the REST v3 surface (/api/v3): repositories, contents, commits, branches, git refs,
// labels, issues, comments and pull requests, all over the shared Store so every other surface
// (git protocol, GraphQL, MCP) sees the same objects.

import {
  Store,
  parseCommit,
  type IssueRec,
  type PullRec,
  type RepoRec,
} from './store.ts';
import {
  diffTrees,
  flattenTree,
  lineDiffCounts,
  makeCommit,
  mergeBaseOf,
  mergeTrees,
  treeDirAt,
  treeEntryAt,
  updateTree,
} from './git.ts';

// ------------------------------------------------------------------ global ids

/** Relay-style global ids: opaque, stable, and decodable back to the object they name. */
export function globalId(kind: string, ...parts: readonly (string | number)[]): string {
  return Buffer.from([kind, ...parts.map(String)].join(':'), 'utf8').toString('base64url');
}

export function parseGlobalId(id: string): string[] | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const parts = text.split(':');
    return parts.length >= 2 ? parts : null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ plumbing

export interface RestRequest {
  method: string;
  segments: string[]; // path segments after /api/v3
  query: URLSearchParams;
  body: Record<string, unknown> | null; // parsed JSON object body, when present
  host: string;
  rawPath: string; // full request path, for Link headers
}

export interface RestResponse {
  status: number;
  json: unknown;
  headers?: Record<string, string>;
}

const notFound = (): RestResponse => ({ status: 404, json: { message: 'Not Found' } });
const validationFailed = (message: string): RestResponse => ({ status: 422, json: { message } });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function paginate<T>(req: RestRequest, items: readonly T[]): { page: T[]; headers: Record<string, string> } {
  const perPageRaw = parseInt(req.query.get('per_page') ?? '30', 10);
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(perPageRaw, 100) : 30;
  const pageRaw = parseInt(req.query.get('page') ?? '1', 10);
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  if (start + perPage < items.length) {
    const lastPage = Math.ceil(items.length / perPage);
    const base = `http://${req.host}${req.rawPath}`;
    headers.link = `<${base}?page=${page + 1}&per_page=${perPage}>; rel="next", <${base}?page=${lastPage}&per_page=${perPage}>; rel="last"`;
  }
  return { page: slice, headers };
}

// ------------------------------------------------------------------ serializers

export function repoJson(store: Store, repo: RepoRec): Record<string, unknown> {
  const owner = store.ownerOf(repo);
  const openCount = [...repo.issues.values()].filter((issue) => issue.state === 'open').length
    + [...repo.pulls.values()].filter((pull) => pull.state === 'open').length;
  return {
    id: repo.id,
    node_id: globalId('Repository', repo.id),
    name: repo.name,
    full_name: `${owner}/${repo.name}`,
    owner: { login: owner, id: 1, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    fork: false,
    html_url: `http://forge/${owner}/${repo.name}`,
    clone_url: `http://forge/${owner}/${repo.name}.git`,
    default_branch: repo.defaultBranch,
    created_at: store.isoOf(repo.seq),
    updated_at: store.isoOf(repo.seq),
    pushed_at: store.isoOf(repo.seq),
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    forks_count: 0,
    open_issues_count: openCount,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    archived: false,
    disabled: false,
    visibility: repo.isPrivate ? 'private' : 'public',
  };
}

function labelJson(store: Store, repo: RepoRec, name: string): Record<string, unknown> {
  const label = repo.labels.get(name);
  return {
    id: label?.id ?? 0,
    node_id: globalId('Label', repo.id, name),
    name,
    color: label?.color ?? 'ededed',
    default: false,
    description: label?.description ?? null,
  };
}

export function issueJson(store: Store, repo: RepoRec, issue: IssueRec): Record<string, unknown> {
  const owner = store.ownerOf(repo);
  return {
    id: 200_000_000 + repo.id * 10_000 + issue.number,
    node_id: globalId('Issue', repo.id, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    locked: false,
    labels: issue.labels.map((name) => labelJson(store, repo, name)),
    assignees: [],
    user: { login: owner, id: 1, type: 'User' },
    comments: issue.comments.length,
    created_at: store.isoOf(issue.seq),
    updated_at: store.isoOf(issue.comments.length > 0 ? issue.comments[issue.comments.length - 1]!.seq : issue.seq),
    closed_at: issue.closedSeq !== null ? store.isoOf(issue.closedSeq) : null,
    html_url: `http://forge/${owner}/${repo.name}/issues/${issue.number}`,
  };
}

export function commentJson(store: Store, repo: RepoRec, comment: { id: number; body: string; seq: number }): Record<string, unknown> {
  const owner = store.ownerOf(repo);
  return {
    id: comment.id,
    node_id: globalId('IssueComment', comment.id),
    body: comment.body,
    user: { login: owner, id: 1, type: 'User' },
    created_at: store.isoOf(comment.seq),
    updated_at: store.isoOf(comment.seq),
    html_url: `http://forge/${owner}/${repo.name}`,
  };
}

function refJson(store: Store, repo: RepoRec, branch: string): Record<string, unknown> {
  const sha = repo.refs.get(`refs/heads/${branch}`) ?? null;
  return {
    label: `${store.ownerOf(repo)}:${branch}`,
    ref: branch,
    sha,
    user: { login: store.ownerOf(repo), id: 1, type: 'User' },
    repo: repoJson(store, repo),
  };
}

/** Whether a pull request merges cleanly right now (a dry three-way tree merge). */
export function pullMergeable(store: Store, repo: RepoRec, pull: PullRec): boolean {
  if (pull.merged || pull.state !== 'open') return false;
  const baseSha = repo.refs.get(`refs/heads/${pull.base}`);
  const headSha = repo.refs.get(`refs/heads/${pull.head}`);
  if (baseSha === undefined || headSha === undefined) return false;
  const baseCommit = store.commitOf(baseSha);
  const headCommit = store.commitOf(headSha);
  if (baseCommit === null || headCommit === null) return false;
  const mergeBase = mergeBaseOf(store, baseSha, headSha);
  if (mergeBase === null) return false;
  if (mergeBase === headSha) return false; // nothing to merge
  const mergeBaseCommit = store.commitOf(mergeBase);
  if (mergeBaseCommit === null) return false;
  const result = mergeTrees(store, mergeBaseCommit.tree, baseCommit.tree, headCommit.tree);
  return 'tree' in result;
}

export function pullJson(store: Store, repo: RepoRec, pull: PullRec): Record<string, unknown> {
  const owner = store.ownerOf(repo);
  const mergeable = pull.merged ? false : pullMergeable(store, repo, pull);
  return {
    id: 300_000_000 + repo.id * 10_000 + pull.number,
    node_id: globalId('PullRequest', repo.id, pull.number),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    locked: false,
    draft: false,
    merged: pull.merged,
    merged_at: pull.mergedSeq !== null ? store.isoOf(pull.mergedSeq) : null,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable,
    mergeable_state: pull.merged ? 'clean' : mergeable ? 'clean' : 'dirty',
    user: { login: owner, id: 1, type: 'User' },
    head: refJson(store, repo, pull.head),
    base: refJson(store, repo, pull.base),
    created_at: store.isoOf(pull.seq),
    updated_at: store.isoOf(pull.mergedSeq ?? pull.seq),
    closed_at: pull.state === 'closed' ? store.isoOf(pull.mergedSeq ?? pull.seq) : null,
    html_url: `http://forge/${owner}/${repo.name}/pull/${pull.number}`,
  };
}

function commitJson(store: Store, sha: string): Record<string, unknown> | null {
  const commit = store.commitOf(sha);
  if (commit === null) return null;
  const ident = (text: string): { name: string; email: string; date: string } => {
    const match = /^(.*?) <(.*?)> (\d+) [+-]\d{4}$/.exec(text);
    if (match === null) return { name: text, email: '', date: store.nowIso() };
    return { name: match[1]!, email: match[2]!, date: new Date(parseInt(match[3]!, 10) * 1000).toISOString() };
  };
  return {
    sha,
    node_id: globalId('Commit', sha),
    commit: {
      author: ident(commit.author),
      committer: ident(commit.committer),
      message: commit.message.replace(/\n$/, ''),
      tree: { sha: commit.tree },
      comment_count: 0,
    },
    author: null,
    committer: null,
    parents: commit.parents.map((parent) => ({ sha: parent })),
  };
}

// ------------------------------------------------------------------ repository helpers

/** Resolve a ref parameter (branch name or commit sha) to a commit sha. */
export function resolveRef(store: Store, repo: RepoRec, ref: string | null): string | null {
  if (ref === null || ref === '') return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  const byBranch = repo.refs.get(`refs/heads/${ref}`);
  if (byBranch !== undefined) return byBranch;
  if (/^[0-9a-f]{40}$/.test(ref) && store.commitOf(ref) !== null) return ref;
  return null;
}

function treeOfCommit(store: Store, sha: string | null): string | null {
  if (sha === null) return null;
  const commit = store.commitOf(sha);
  return commit === null ? null : commit.tree;
}

// ------------------------------------------------------------------ the router

export function handleRest(store: Store, req: RestRequest): RestResponse {
  const seg = req.segments;
  const method = req.method;

  // GET /meta — the installation banner (GitHub Enterprise's shape).
  if (seg.length === 1 && seg[0] === 'meta' && method === 'GET') {
    return {
      status: 200,
      json: {
        verifiable_password_authentication: false,
        ssh_key_fingerprints: {},
        installed_version: '1.0.0-forge',
        github_developer_program_url: '',
      },
    };
  }

  // GET /user — the token's profile (404 until the owner's login has been bound by an owner path).
  if (seg.length === 1 && seg[0] === 'user' && method === 'GET') {
    if (store.boundOwner === null) return notFound();
    return { status: 200, json: { login: store.boundOwner, id: 1, type: 'User', name: store.boundOwner } };
  }

  // /user/repos — create and list.
  if (seg.length === 2 && seg[0] === 'user' && seg[1] === 'repos') {
    if (method === 'POST') {
      const body = req.body ?? {};
      const name = str(body.name);
      if (name === null || name === '' || !/^[A-Za-z0-9._-]+$/.test(name)) return validationFailed('Repository creation failed.');
      const repo = store.createRepo(name, body.private === true, str(body.description) ?? '');
      if (repo === null) {
        return {
          status: 422,
          json: {
            message: 'Repository creation failed.',
            errors: [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }],
          },
        };
      }
      if (body.auto_init === true) {
        const readme = store.putObject('blob', Buffer.from(`# ${name}\n`, 'utf8'));
        const tree = updateTree(store, null, 'README.md', readme);
        const commit = makeCommit(store, { tree, parents: [], message: 'Initial commit', seq: store.nextSeq() });
        repo.refs.set(`refs/heads/${repo.defaultBranch}`, commit);
      }
      return { status: 201, json: repoJson(store, repo) };
    }
    if (method === 'GET') {
      const { page, headers } = paginate(req, store.allRepos().map((repo) => repoJson(store, repo)));
      return { status: 200, json: page, headers };
    }
  }

  if (seg[0] !== 'repos' || seg.length < 3) return notFound();
  const owner = seg[1]!;
  const repo = store.findRepo(owner, seg[2]!);
  if (repo === null) return notFound();
  const rest = seg.slice(3);
  return handleRepo(store, req, repo, rest);
}

function handleRepo(store: Store, req: RestRequest, repo: RepoRec, seg: string[]): RestResponse {
  const method = req.method;
  const body = req.body ?? {};

  // The repository itself.
  if (seg.length === 0) {
    if (method === 'GET') return { status: 200, json: repoJson(store, repo) };
    if (method === 'PATCH') {
      if (typeof body.private === 'boolean') repo.isPrivate = body.private;
      if (typeof body.description === 'string') repo.description = body.description;
      return { status: 200, json: repoJson(store, repo) };
    }
    if (method === 'DELETE') {
      store.deleteRepo(repo);
      return { status: 204, json: null };
    }
    return notFound();
  }

  // ------------------------------------------------------------ contents
  if (seg[0] === 'contents') {
    const path = seg.slice(1).join('/');
    if (method === 'GET') return getContents(store, req, repo, path);
    if (method === 'PUT') return putContents(store, req, repo, path);
    if (method === 'DELETE') return deleteContents(store, req, repo, path);
    return notFound();
  }

  // ------------------------------------------------------------ commits
  if (seg[0] === 'commits') {
    if (seg.length === 1 && method === 'GET') {
      const start = resolveRef(store, repo, req.query.get('sha'));
      if (start === null) return { status: 200, json: [] };
      const ordered: string[] = [];
      const seen = new Set<string>();
      const queue = [start];
      while (queue.length > 0 && ordered.length < 1000) {
        const sha = queue.shift()!;
        if (seen.has(sha)) continue;
        seen.add(sha);
        const commit = store.commitOf(sha);
        if (commit === null) continue;
        ordered.push(sha);
        queue.push(...commit.parents);
      }
      const { page, headers } = paginate(req, ordered.map((sha) => commitJson(store, sha)).filter((entry) => entry !== null));
      return { status: 200, json: page, headers };
    }
    if (seg.length === 2 && method === 'GET') {
      const json = commitJson(store, seg[1]!);
      return json === null ? notFound() : { status: 200, json };
    }
    return notFound();
  }

  // ------------------------------------------------------------ branches & git refs
  if (seg[0] === 'branches' && seg.length === 1 && method === 'GET') {
    const branches = [...repo.refs.keys()]
      .filter((ref) => ref.startsWith('refs/heads/'))
      .map((ref) => ref.slice('refs/heads/'.length))
      .sort()
      .map((name) => ({ name, commit: { sha: repo.refs.get(`refs/heads/${name}`)! }, protected: false }));
    const { page, headers } = paginate(req, branches);
    return { status: 200, json: page, headers };
  }
  if (seg[0] === 'branches' && seg.length === 2 && method === 'GET') {
    const branch = seg[1]!;
    const sha = repo.refs.get(`refs/heads/${branch}`);
    if (sha === undefined) return notFound();
    return { status: 200, json: { name: branch, commit: { sha }, protected: false } };
  }
  if (seg[0] === 'git' && seg[1] === 'refs') {
    if (seg.length === 2 && method === 'POST') {
      const ref = str(body.ref);
      const sha = str(body.sha);
      if (ref === null || sha === null || store.peelToCommit(sha) === null) return validationFailed('Object is not a commit');
      repo.refs.set(ref, sha);
      return { status: 201, json: { ref, object: { sha, type: 'commit' } } };
    }
    if (method === 'GET') {
      const ref = `refs/${seg.slice(2).join('/')}`;
      const sha = repo.refs.get(ref);
      if (sha === undefined) return notFound();
      const obj = store.getObject(sha);
      return { status: 200, json: { ref, object: { sha, type: obj?.type ?? 'commit' } } };
    }
    if (method === 'DELETE') {
      const ref = `refs/${seg.slice(2).join('/')}`;
      if (!repo.refs.delete(ref)) return notFound();
      return { status: 204, json: null };
    }
    return notFound();
  }

  // ------------------------------------------------------------ labels
  if (seg[0] === 'labels') {
    if (seg.length === 1 && method === 'GET') {
      return { status: 200, json: [...repo.labels.values()].map((label) => labelJson(store, repo, label.name)) };
    }
    if (seg.length === 1 && method === 'POST') {
      const name = str(body.name);
      if (name === null || name === '') return validationFailed('Label creation failed.');
      if (repo.labels.has(name)) return validationFailed('Label already exists.');
      repo.labels.set(name, {
        id: store.nextLabelId(),
        name,
        color: (str(body.color) ?? 'ededed').replace(/^#/, ''),
        description: str(body.description),
      });
      return { status: 201, json: labelJson(store, repo, name) };
    }
    return notFound();
  }

  // ------------------------------------------------------------ issues
  if (seg[0] === 'issues') return handleIssues(store, req, repo, seg.slice(1));

  // ------------------------------------------------------------ pulls
  if (seg[0] === 'pulls') return handlePulls(store, req, repo, seg.slice(1));

  return notFound();
}

// ------------------------------------------------------------------ contents

function contentsEntry(store: Store, repo: RepoRec, path: string, entry: { mode: string; name: string; sha: string }): Record<string, unknown> {
  const obj = store.getObject(entry.sha);
  return {
    name: entry.name,
    path,
    sha: entry.sha,
    size: entry.mode === '40000' ? 0 : obj?.data.length ?? 0,
    type: entry.mode === '40000' ? 'dir' : 'file',
    html_url: `http://forge/${store.ownerOf(repo)}/${repo.name}/blob/${repo.defaultBranch}/${path}`,
    download_url: null,
  };
}

function getContents(store: Store, req: RestRequest, repo: RepoRec, path: string): RestResponse {
  const commitSha = resolveRef(store, repo, req.query.get('ref'));
  const tree = treeOfCommit(store, commitSha);
  if (tree === null) return notFound();
  const clean = path.replace(/^\/+|\/+$/g, '');
  if (clean === '') {
    const entries = treeDirAt(store, tree, '') ?? [];
    return { status: 200, json: entries.map((entry) => contentsEntry(store, repo, entry.name, entry)) };
  }
  const entry = treeEntryAt(store, tree, clean);
  if (entry === null) return notFound();
  if (entry.mode === '40000') {
    const entries = treeDirAt(store, tree, clean) ?? [];
    return { status: 200, json: entries.map((child) => contentsEntry(store, repo, `${clean}/${child.name}`, child)) };
  }
  const obj = store.getObject(entry.sha);
  if (obj === undefined) return notFound();
  return {
    status: 200,
    json: {
      ...contentsEntry(store, repo, clean, entry),
      encoding: 'base64',
      content: obj.data.toString('base64'),
    },
  };
}

/** The branch a contents write targets, creating the ref (from the default branch) when asked to. */
function writeBranchTip(store: Store, repo: RepoRec, branch: string | null): { ref: string; tip: string | null } {
  const name = branch ?? repo.defaultBranch;
  const ref = `refs/heads/${name}`;
  let tip = repo.refs.get(ref) ?? null;
  if (tip === null && branch !== null && name !== repo.defaultBranch) {
    tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  }
  return { ref, tip };
}

function putContents(store: Store, req: RestRequest, repo: RepoRec, path: string): RestResponse {
  const body = req.body ?? {};
  const content = str(body.content);
  const message = str(body.message);
  if (content === null || message === null || path === '') return validationFailed('Content creation failed.');
  const branch = str(body.branch);
  const { ref, tip } = writeBranchTip(store, repo, branch);
  const tree = treeOfCommit(store, tip);
  const existing = tree === null ? null : treeEntryAt(store, tree, path);
  const givenSha = str(body.sha);
  if (existing !== null && givenSha !== null && givenSha !== existing.sha) {
    return { status: 409, json: { message: `${path} does not match ${givenSha}` } };
  }
  const data = Buffer.from(content.replace(/\s+/g, ''), 'base64');
  const blobSha = store.putObject('blob', data);
  const newTree = updateTree(store, tree, path, blobSha);
  const commit = makeCommit(store, {
    tree: newTree,
    parents: tip === null ? [] : [tip],
    message,
    seq: store.nextSeq(),
  });
  repo.refs.set(ref, commit);
  const created = existing === null;
  return {
    status: created ? 201 : 200,
    json: {
      content: { ...contentsEntry(store, repo, path, { mode: '100644', name: path.split('/').pop()!, sha: blobSha }), encoding: 'base64' },
      commit: { sha: commit, message, author: { name: 'Forge', email: 'forge@localhost' }, committer: { name: 'Forge', email: 'forge@localhost' } },
    },
  };
}

function deleteContents(store: Store, req: RestRequest, repo: RepoRec, path: string): RestResponse {
  const body = req.body ?? {};
  const message = str(body.message);
  if (message === null) return validationFailed('Content deletion failed.');
  const branch = str(body.branch);
  const { ref, tip } = writeBranchTip(store, repo, branch);
  const tree = treeOfCommit(store, tip);
  if (tree === null || tip === null) return notFound();
  const existing = treeEntryAt(store, tree, path);
  if (existing === null) return notFound();
  const givenSha = str(body.sha);
  if (givenSha !== null && givenSha !== existing.sha) return { status: 409, json: { message: `${path} does not match ${givenSha}` } };
  const newTree = updateTree(store, tree, path, null);
  const commit = makeCommit(store, { tree: newTree, parents: [tip], message, seq: store.nextSeq() });
  repo.refs.set(ref, commit);
  return {
    status: 200,
    json: {
      content: null,
      commit: { sha: commit, message, author: { name: 'Forge', email: 'forge@localhost' }, committer: { name: 'Forge', email: 'forge@localhost' } },
    },
  };
}

// ------------------------------------------------------------------ issues

function handleIssues(store: Store, req: RestRequest, repo: RepoRec, seg: string[]): RestResponse {
  const method = req.method;
  const body = req.body ?? {};

  if (seg.length === 0) {
    if (method === 'POST') {
      const title = str(body.title);
      if (title === null || title === '') return validationFailed('Issue creation failed.');
      const labelNames: string[] = [];
      if (Array.isArray(body.labels)) {
        for (const raw of body.labels) {
          const name = typeof raw === 'string' ? raw : isRecord(raw) ? str(raw.name) : null;
          if (name === null) continue;
          if (!repo.labels.has(name)) return validationFailed(`Validation Failed: label "${name}" does not exist`);
          labelNames.push(name);
        }
      }
      const number = repo.nextNumber;
      repo.nextNumber += 1;
      const issue: IssueRec = {
        number,
        title,
        body: str(body.body) ?? '',
        state: 'open',
        labels: labelNames,
        comments: [],
        seq: store.nextSeq(),
        closedSeq: null,
      };
      repo.issues.set(number, issue);
      return { status: 201, json: issueJson(store, repo, issue) };
    }
    if (method === 'GET') {
      const state = req.query.get('state') ?? 'open';
      const all = [...repo.issues.values()].sort((a, b) => a.number - b.number);
      if (req.query.get('direction') === 'desc') all.reverse();
      const filtered = state === 'all' ? all : all.filter((issue) => issue.state === state);
      const { page, headers } = paginate(req, filtered.map((issue) => issueJson(store, repo, issue)));
      return { status: 200, json: page, headers };
    }
    return notFound();
  }

  const number = parseInt(seg[0]!, 10);
  if (!Number.isFinite(number)) return notFound();
  const issue = repo.issues.get(number);
  const pull = repo.pulls.get(number);

  if (seg.length === 1) {
    if (issue === undefined) {
      // GitHub answers a pull request's number on the issues surface too, marked as one.
      if (pull !== undefined && method === 'GET') {
        return { status: 200, json: { ...pullJson(store, repo, pull), pull_request: { url: `http://forge/${store.ownerOf(repo)}/${repo.name}/pulls/${number}` } } };
      }
      return notFound();
    }
    if (method === 'GET') return { status: 200, json: issueJson(store, repo, issue) };
    if (method === 'PATCH') {
      if (typeof body.title === 'string') issue.title = body.title;
      if (typeof body.body === 'string') issue.body = body.body;
      if (body.state === 'closed' && issue.state !== 'closed') {
        issue.state = 'closed';
        issue.closedSeq = store.nextSeq();
      } else if (body.state === 'open') {
        issue.state = 'open';
        issue.closedSeq = null;
      }
      if (Array.isArray(body.labels)) {
        const names: string[] = [];
        for (const raw of body.labels) {
          const name = typeof raw === 'string' ? raw : isRecord(raw) ? str(raw.name) : null;
          if (name === null) continue;
          if (!repo.labels.has(name)) return validationFailed(`Validation Failed: label "${name}" does not exist`);
          names.push(name);
        }
        issue.labels = names;
      }
      return { status: 200, json: issueJson(store, repo, issue) };
    }
    return notFound();
  }

  if (issue === undefined) return notFound();

  if (seg[1] === 'comments' && seg.length === 2) {
    if (method === 'GET') {
      return { status: 200, json: issue.comments.map((comment) => commentJson(store, repo, comment)) };
    }
    if (method === 'POST') {
      const text = str(body.body);
      if (text === null) return validationFailed('Comment creation failed.');
      const comment = { id: store.nextCommentId(), body: text, seq: store.nextSeq() };
      issue.comments.push(comment);
      return { status: 201, json: commentJson(store, repo, comment) };
    }
    return notFound();
  }

  if (seg[1] === 'labels') {
    if (method === 'GET') return { status: 200, json: issue.labels.map((name) => labelJson(store, repo, name)) };
    if (method === 'POST') {
      const names = Array.isArray(body.labels) ? body.labels : [];
      for (const raw of names) {
        const name = typeof raw === 'string' ? raw : isRecord(raw) ? str(raw.name) : null;
        if (name === null) continue;
        if (!repo.labels.has(name)) {
          repo.labels.set(name, { id: store.nextLabelId(), name, color: 'ededed', description: null });
        }
        if (!issue.labels.includes(name)) issue.labels.push(name);
      }
      return { status: 200, json: issue.labels.map((name) => labelJson(store, repo, name)) };
    }
    return notFound();
  }

  return notFound();
}

// ------------------------------------------------------------------ pull requests

function handlePulls(store: Store, req: RestRequest, repo: RepoRec, seg: string[]): RestResponse {
  const method = req.method;
  const body = req.body ?? {};

  if (seg.length === 0) {
    if (method === 'POST') {
      const title = str(body.title);
      const headRaw = str(body.head);
      const base = str(body.base) ?? repo.defaultBranch;
      if (title === null || headRaw === null) return validationFailed('Pull request creation failed.');
      const head = headRaw.includes(':') ? headRaw.split(':').pop()! : headRaw;
      if (!repo.refs.has(`refs/heads/${head}`)) {
        return { status: 422, json: { message: 'Validation Failed', errors: [{ resource: 'PullRequest', field: 'head', code: 'invalid' }] } };
      }
      if (!repo.refs.has(`refs/heads/${base}`)) {
        return { status: 422, json: { message: 'Validation Failed', errors: [{ resource: 'PullRequest', field: 'base', code: 'invalid' }] } };
      }
      if (head === base) return validationFailed('Validation Failed: head and base are the same.');
      for (const existing of repo.pulls.values()) {
        if (existing.state === 'open' && existing.head === head && existing.base === base) {
          return { status: 422, json: { message: 'Validation Failed', errors: [{ resource: 'PullRequest', code: 'custom', message: `A pull request already exists for ${head} into ${base}.` }] } };
        }
      }
      const number = repo.nextNumber;
      repo.nextNumber += 1;
      const pull: PullRec = {
        number,
        title,
        body: str(body.body) ?? '',
        state: 'open',
        head,
        base,
        merged: false,
        mergedSeq: null,
        mergeCommitSha: null,
        seq: store.nextSeq(),
      };
      repo.pulls.set(number, pull);
      return { status: 201, json: pullJson(store, repo, pull) };
    }
    if (method === 'GET') {
      const state = req.query.get('state') ?? 'open';
      const all = [...repo.pulls.values()].sort((a, b) => a.number - b.number);
      if (req.query.get('direction') === 'desc') all.reverse();
      const filtered = state === 'all' ? all : all.filter((pull) => pull.state === state);
      const { page, headers } = paginate(req, filtered.map((pull) => pullJson(store, repo, pull)));
      return { status: 200, json: page, headers };
    }
    return notFound();
  }

  const number = parseInt(seg[0]!, 10);
  if (!Number.isFinite(number)) return notFound();
  const pull = repo.pulls.get(number);
  if (pull === undefined) return notFound();

  if (seg.length === 1) {
    if (method === 'GET') return { status: 200, json: pullJson(store, repo, pull) };
    if (method === 'PATCH') {
      if (typeof body.title === 'string') pull.title = body.title;
      if (typeof body.body === 'string') pull.body = body.body;
      if (body.state === 'closed') pull.state = 'closed';
      if (body.state === 'open' && !pull.merged) pull.state = 'open';
      return { status: 200, json: pullJson(store, repo, pull) };
    }
    return notFound();
  }

  if (seg[1] === 'files' && seg.length === 2 && method === 'GET') {
    const files = pullFiles(store, repo, pull);
    const { page, headers } = paginate(req, files);
    return { status: 200, json: page, headers };
  }

  if (seg[1] === 'merge' && seg.length === 2 && method === 'PUT') {
    return mergePull(store, repo, pull, body);
  }

  return notFound();
}

/** The changed-file list between a pull request's merge base and its head. */
export function pullFiles(store: Store, repo: RepoRec, pull: PullRec): Record<string, unknown>[] {
  const baseSha = repo.refs.get(`refs/heads/${pull.base}`);
  const headSha = repo.refs.get(`refs/heads/${pull.head}`);
  if (baseSha === undefined || headSha === undefined) return [];
  const mergeBase = mergeBaseOf(store, baseSha, headSha) ?? baseSha;
  const baseCommit = store.commitOf(mergeBase);
  const headCommit = store.commitOf(headSha);
  if (baseCommit === null || headCommit === null) return [];
  const baseFlat = flattenTree(store, baseCommit.tree);
  const changes = diffTrees(store, baseCommit.tree, headCommit.tree);
  return changes.map((change) => {
    const oldText = change.oldSha === null ? '' : store.getObject(change.oldSha)?.data.toString('utf8') ?? '';
    const newText = change.newSha === null ? '' : store.getObject(change.newSha)?.data.toString('utf8') ?? '';
    const counts = lineDiffCounts(oldText, newText);
    void baseFlat;
    return {
      sha: change.newSha ?? change.oldSha ?? '',
      filename: change.path,
      status: change.status,
      additions: Math.max(counts.additions, change.status === 'added' ? 1 : 0),
      deletions: counts.deletions,
      changes: counts.additions + counts.deletions,
    };
  });
}

function mergePull(store: Store, repo: RepoRec, pull: PullRec, body: Record<string, unknown>): RestResponse {
  const method = typeof body.merge_method === 'string' ? body.merge_method : 'merge';
  if (pull.merged || pull.state !== 'open') {
    return { status: 405, json: { message: 'Pull Request is not mergeable' } };
  }
  const baseRef = `refs/heads/${pull.base}`;
  const baseSha = repo.refs.get(baseRef);
  const headSha = repo.refs.get(`refs/heads/${pull.head}`);
  if (baseSha === undefined || headSha === undefined) return { status: 405, json: { message: 'Pull Request is not mergeable' } };
  const baseCommit = store.commitOf(baseSha);
  const headCommit = store.commitOf(headSha);
  if (baseCommit === null || headCommit === null) return { status: 405, json: { message: 'Pull Request is not mergeable' } };
  const mergeBase = mergeBaseOf(store, baseSha, headSha);
  if (mergeBase === null || mergeBase === headSha) return { status: 405, json: { message: 'Pull Request is not mergeable' } };
  const mergeBaseCommit = store.commitOf(mergeBase);
  if (mergeBaseCommit === null) return { status: 405, json: { message: 'Pull Request is not mergeable' } };
  const merged = mergeTrees(store, mergeBaseCommit.tree, baseCommit.tree, headCommit.tree);
  if ('conflict' in merged) return { status: 405, json: { message: 'Pull Request is not mergeable' } };
  const seq = store.nextSeq();
  let commit: string;
  if (method === 'squash') {
    commit = makeCommit(store, {
      tree: merged.tree,
      parents: [baseSha],
      message: `${pull.title} (#${pull.number})`,
      seq,
    });
  } else {
    commit = makeCommit(store, {
      tree: merged.tree,
      parents: [baseSha, headSha],
      message: `Merge pull request #${pull.number} from ${pull.head}`,
      seq,
    });
  }
  repo.refs.set(baseRef, commit);
  pull.merged = true;
  pull.state = 'closed';
  pull.mergedSeq = seq;
  pull.mergeCommitSha = commit;
  return { status: 200, json: { sha: commit, merged: true, message: 'Pull Request successfully merged' } };
}
