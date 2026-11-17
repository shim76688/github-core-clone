// graphql.ts — the GraphQL v4 surface (POST /api/graphql): a small parser (operations, fragments,
// aliases, variables, input objects) and an executor over the shared Store, shaped for the
// documents gh and github-mcp-server send. Unknown fields answer 200 with an `errors` array that
// names the field, as GitHub does; a missing repository is data.repository = null with no errors.

import type { IssueRec, PullRec, RepoRec, Store } from './store.ts';
import { globalId, parseGlobalId, createIssueRecord, createPullRecord, performMerge, pullFiles, pullMergeable } from './rest.ts';
import { mergeBaseOf } from './git.ts';

export interface GraphQLResponse {
  status: number;
  json: unknown;
}

// ------------------------------------------------------------------ lexer

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'punct'; value: string }
  | { kind: 'eof' };

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '﻿') { i += 1; continue; }
    if (ch === '#') { while (i < source.length && source[i] !== '\n') i += 1; continue; }
    if (source.startsWith('...', i)) { tokens.push({ kind: 'punct', value: '...' }); i += 3; continue; }
    if ('{}()[]:=@$!|&'.includes(ch)) { tokens.push({ kind: 'punct', value: ch }); i += 1; continue; }
    if (ch === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        tokens.push({ kind: 'string', value: source.slice(i + 3, end === -1 ? source.length : end) });
        i = end === -1 ? source.length : end + 3;
        continue;
      }
      let value = '';
      i += 1;
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\\' && i + 1 < source.length) {
          const esc = source[i + 1]!;
          value += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          i += 2;
        } else {
          value += source[i];
          i += 1;
        }
      }
      i += 1;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      const match = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(source.slice(i))!;
      const text = match[0];
      tokens.push(text.includes('.') || /[eE]/.test(text) ? { kind: 'float', value: parseFloat(text) } : { kind: 'int', value: parseInt(text, 10) });
      i += text.length;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      const match = /^[_A-Za-z][_0-9A-Za-z]*/.exec(source.slice(i))!;
      tokens.push({ kind: 'name', value: match[0] });
      i += match[0].length;
      continue;
    }
    i += 1;
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

// ------------------------------------------------------------------ parser

type Value =
  | { kind: 'var'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'enum'; value: string }
  | { kind: 'null' }
  | { kind: 'list'; items: Value[] }
  | { kind: 'object'; fields: Map<string, Value> };

interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Map<string, Value>;
  selectionSet: SelectionNode[] | null;
}
type SelectionNode =
  | FieldNode
  | { kind: 'spread'; name: string }
  | { kind: 'inline'; typeCondition: string | null; selectionSet: SelectionNode[] };

interface Operation {
  type: 'query' | 'mutation';
  name: string | null;
  selectionSet: SelectionNode[];
}

interface Document {
  operations: Operation[];
  fragments: Map<string, { typeCondition: string | null; selectionSet: SelectionNode[] }>;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos]!;
  }

  private next(): Token {
    const token = this.tokens[this.pos]!;
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected "${value}"`);
  }

  private atPunct(value: string): boolean {
    const token = this.peek();
    return token.kind === 'punct' && token.value === value;
  }

  parseDocument(): Document {
    const operations: Operation[] = [];
    const fragments = new Map<string, { typeCondition: string | null; selectionSet: SelectionNode[] }>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ type: 'query', name: null, selectionSet: this.parseSelectionSet() });
        continue;
      }
      if (token.kind !== 'name') throw new Error('expected a definition');
      if (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription') {
        this.next();
        let name: string | null = null;
        if (this.peek().kind === 'name') name = this.next().value as string;
        if (this.atPunct('(')) this.skipBalanced('(', ')');
        // directives after variable definitions
        while (this.atPunct('@')) { this.next(); this.next(); if (this.atPunct('(')) this.skipBalanced('(', ')'); }
        operations.push({ type: token.value === 'mutation' ? 'mutation' : 'query', name, selectionSet: this.parseSelectionSet() });
        continue;
      }
      if (token.value === 'fragment') {
        this.next();
        const nameToken = this.next();
        if (nameToken.kind !== 'name') throw new Error('fragment name expected');
        const onToken = this.next();
        if (onToken.kind !== 'name' || onToken.value !== 'on') throw new Error('fragment "on" expected');
        const typeToken = this.next();
        fragments.set(nameToken.value, {
          typeCondition: typeToken.kind === 'name' ? typeToken.value : null,
          selectionSet: this.parseSelectionSet(),
        });
        continue;
      }
      throw new Error(`unexpected definition "${token.value}"`);
    }
    return { operations, fragments };
  }

  private skipBalanced(open: string, close: string): void {
    let depth = 0;
    for (;;) {
      const token = this.next();
      if (token.kind === 'eof') return;
      if (token.kind === 'punct' && token.value === open) depth += 1;
      if (token.kind === 'punct' && token.value === close) {
        depth -= 1;
        if (depth === 0) return;
      }
    }
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.atPunct('}')) {
      if (this.peek().kind === 'eof') throw new Error('unterminated selection set');
      if (this.atPunct('...')) {
        this.next();
        const token = this.peek();
        if (token.kind === 'name' && token.value === 'on') {
          this.next();
          const typeToken = this.next();
          selections.push({
            kind: 'inline',
            typeCondition: typeToken.kind === 'name' ? typeToken.value : null,
            selectionSet: this.parseSelectionSet(),
          });
        } else if (token.kind === 'name') {
          this.next();
          selections.push({ kind: 'spread', name: token.value });
        } else {
          selections.push({ kind: 'inline', typeCondition: null, selectionSet: this.parseSelectionSet() });
        }
        continue;
      }
      selections.push(this.parseField());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseField(): FieldNode {
    const first = this.next();
    if (first.kind !== 'name') throw new Error('field name expected');
    let alias: string | null = null;
    let name = first.value;
    if (this.atPunct(':')) {
      this.next();
      const second = this.next();
      if (second.kind !== 'name') throw new Error('field name after alias expected');
      alias = name;
      name = second.value;
    }
    const args = new Map<string, Value>();
    if (this.atPunct('(')) {
      this.next();
      while (!this.atPunct(')')) {
        const argName = this.next();
        if (argName.kind !== 'name') throw new Error('argument name expected');
        this.expectPunct(':');
        args.set(argName.value, this.parseValue());
      }
      this.expectPunct(')');
    }
    while (this.atPunct('@')) { this.next(); this.next(); if (this.atPunct('(')) this.skipBalanced('(', ')'); }
    const selectionSet = this.atPunct('{') ? this.parseSelectionSet() : null;
    return { kind: 'field', alias, name, args, selectionSet };
  }

  private parseValue(): Value {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      const nameToken = this.next();
      return { kind: 'var', name: nameToken.kind === 'name' ? nameToken.value : '' };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const items: Value[] = [];
      while (!this.atPunct(']')) items.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', items };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields = new Map<string, Value>();
      while (!this.atPunct('}')) {
        const key = this.next();
        if (key.kind !== 'name') throw new Error('object key expected');
        this.expectPunct(':');
        fields.set(key.value, this.parseValue());
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int' || token.kind === 'float') return { kind: 'number', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error('unexpected value token');
  }
}

// ------------------------------------------------------------------ execution context

interface Ctx {
  store: Store;
  variables: Record<string, unknown>;
  fragments: Map<string, { typeCondition: string | null; selectionSet: SelectionNode[] }>;
  errors: { message: string }[];
}

function resolveValue(ctx: Ctx, value: Value): unknown {
  switch (value.kind) {
    case 'var': return ctx.variables[value.name];
    case 'string': return value.value;
    case 'number': return value.value;
    case 'boolean': return value.value;
    case 'enum': return value.value;
    case 'null': return null;
    case 'list': return value.items.map((item) => resolveValue(ctx, item));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, entry] of value.fields) out[key] = resolveValue(ctx, entry);
      return out;
    }
  }
}

function argsOf(ctx: Ctx, field: FieldNode): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of field.args) out[key] = resolveValue(ctx, value);
  return out;
}

// ------------------------------------------------------------------ object descriptors

type Desc =
  | { __type: 'User'; login: string }
  | { __type: 'Repository'; repo: RepoRec }
  | { __type: 'Issue'; repo: RepoRec; issue: IssueRec }
  | { __type: 'PullRequest'; repo: RepoRec; pull: PullRec }
  | { __type: 'Ref'; name: string; sha: string | null }
  | { __type: 'Commit'; sha: string }
  | { __type: 'Comment'; repo: RepoRec; id: number; body: string }
  | { __type: 'Label'; repo: RepoRec; name: string }
  | { __type: 'Type'; name: string }
  | { __type: 'TypeField'; name: string }
  | { __type: 'EnumValue'; name: string }
  | { __type: 'Payload'; payload: string; fields: Record<string, unknown> }
  | { __type: 'Connection'; total: number; items: Desc[]; hasNextPage: boolean; endCursor: string | null }
  | { __type: 'PageInfo'; hasNextPage: boolean; hasPreviousPage: boolean; startCursor: string | null; endCursor: string | null }
  | { __type: 'Edge'; node: Desc; cursor: string };

const cursorOf = (index: number): string => Buffer.from(`cursor:${index}`, 'utf8').toString('base64url');

function indexOfCursor(after: unknown): number {
  if (typeof after !== 'string' || after === '') return -1;
  try {
    const text = Buffer.from(after, 'base64url').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match === null ? -1 : parseInt(match[1]!, 10);
  } catch {
    return -1;
  }
}

/** Slice a full ordered list into a connection for (first, after). */
function connection(items: Desc[], args: Record<string, unknown>): Desc {
  const first = typeof args.first === 'number' && args.first >= 0 ? Math.floor(args.first) : items.length;
  const start = indexOfCursor(args.after) + 1;
  const slice = items.slice(start, start + first);
  const hasNextPage = start + slice.length < items.length;
  return {
    __type: 'Connection',
    total: items.length,
    items: slice,
    hasNextPage,
    endCursor: slice.length > 0 ? cursorOf(start + slice.length - 1) : null,
  };
}

// ------------------------------------------------------------------ schema (for introspection)

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', 'nodes', 'rateLimit', 'search', 'user', 'organization'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment', 'updateIssue', 'createRepository'],
  User: ['id', 'login', 'name', 'email', 'url', 'avatarUrl', 'isViewer', 'createdAt', 'updatedAt'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'description', 'isPrivate',
    'isFork', 'isArchived', 'url', 'createdAt', 'updatedAt', 'stargazerCount', 'forkCount', 'ref', 'refs',
    'primaryLanguage', 'licenseInfo', 'viewerCanAdminister', 'repositoryTopics', 'labels', 'collaborators',
  ],
  Issue: [
    'id', 'number', 'title', 'state', 'body', 'author', 'repository', 'labels', 'comments', 'createdAt',
    'updatedAt', 'closed', 'closedAt', 'url', 'viewerCanUpdate', 'assignees', 'milestone', 'reactions',
    'participants', 'timelineItems', 'stateReason', 'isPinned', 'viewerCanReact',
  ],
  PullRequest: [
    'id', 'number', 'title', 'state', 'body', 'merged', 'mergeable', 'headRefName', 'baseRefName',
    'headRef', 'baseRef', 'files', 'author', 'repository', 'createdAt', 'updatedAt', 'mergedAt',
    'mergeCommit', 'url', 'additions', 'deletions', 'changedFiles', 'commits', 'reviews', 'comments',
    'isDraft', 'closed', 'mergedBy', 'potentialMergeCommit', 'viewerCanUpdate',
  ],
  Ref: ['id', 'name', 'prefix', 'target', 'repository'],
  Commit: ['id', 'oid', 'abbreviatedOid', 'message', 'messageHeadline', 'authoredDate', 'committedDate', 'tree', 'parents', 'author', 'committer', 'url', 'history'],
  Tree: ['id', 'oid', 'abbreviatedOid', 'entries'],
  Blob: ['id', 'oid', 'abbreviatedOid', 'text', 'isTruncated', 'byteSize'],
  IssueComment: ['id', 'body', 'author', 'createdAt', 'updatedAt', 'url', 'issue'],
  Label: ['id', 'name', 'color', 'description', 'url'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType', 'viewerViewedState'],
  SearchResultItemConnection: ['nodes', 'pageInfo', 'issueCount', 'repositoryCount', 'userCount', 'wikiCount'],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'ISSUE_ADVANCED'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  MergePullRequestMethod: ['MERGE', 'SQUASH', 'REBASE'],
};

// ------------------------------------------------------------------ field resolution

type Raw = unknown;

function userDesc(login: string): Desc {
  return { __type: 'User', login };
}

function repoDesc(repo: RepoRec): Desc {
  return { __type: 'Repository', repo };
}

function issueDesc(repo: RepoRec, issue: IssueRec): Desc {
  return { __type: 'Issue', repo, issue };
}

function pullDesc(repo: RepoRec, pull: PullRec): Desc {
  return { __type: 'PullRequest', repo, pull };
}

function isDesc(value: unknown): value is Desc {
  return typeof value === 'object' && value !== null && '__type' in (value as Record<string, unknown>);
}

/** Resolve one field on one descriptor (or on the Query/Mutation root, source = null). */
function resolveField(ctx: Ctx, typeName: string, source: Desc | null, field: FieldNode): Raw {
  const store = ctx.store;
  const args = argsOf(ctx, field);
  const name = field.name;

  if (name === '__typename') return source === null ? typeName : source.__type;

  if (typeName === 'Query') {
    switch (name) {
      case 'viewer': return userDesc(store.boundOwner ?? '');
      case 'repository': {
        const repo = store.findRepo(String(args.owner ?? ''), String(args.name ?? ''));
        return repo === null ? null : repoDesc(repo);
      }
      case 'node': return nodeById(ctx, String(args.id ?? ''));
      case 'nodes': return Array.isArray(args.ids) ? args.ids.map((id) => nodeById(ctx, String(id))) : [];
      case 'user': return userDesc(String(args.login ?? ''));
      case '__type': return { __type: 'Type', name: String(args.name ?? '') } satisfies Desc;
      case '__schema': return { __type: 'Payload', payload: 'Schema', fields: {} } satisfies Desc;
      case 'rateLimit': return { __type: 'Payload', payload: 'RateLimit', fields: { limit: 5000, remaining: 4999, used: 1, cost: 1, nodeCount: 0, resetAt: '2099-01-01T00:00:00Z' } } satisfies Desc;
      default: break;
    }
  }

  if (typeName === 'Mutation') {
    return resolveMutation(ctx, name, args);
  }

  if (source === null) {
    ctx.errors.push({ message: `Field '${name}' doesn't exist on type '${typeName}'` });
    return null;
  }

  switch (source.__type) {
    case 'User': {
      switch (name) {
        case 'login': return source.login;
        case 'id': return globalId('User', source.login);
        case 'name': return source.login;
        case 'email': return '';
        case 'url': return `http://forge/${source.login}`;
        case 'avatarUrl': return '';
        case 'isViewer': return store.boundOwner === source.login;
        case 'createdAt': case 'updatedAt': return store.isoOf(1);
        default: break;
      }
      break;
    }
    case 'Repository': {
      const repo = source.repo;
      const owner = store.ownerOf(repo);
      switch (name) {
        case 'id': return globalId('Repository', repo.id);
        case 'databaseId': return repo.id;
        case 'name': return repo.name;
        case 'nameWithOwner': return `${owner}/${repo.name}`;
        case 'owner': return userDesc(owner);
        case 'description': return repo.description;
        case 'isPrivate': return repo.isPrivate;
        case 'isFork': return false;
        case 'isArchived': return false;
        case 'url': return `http://forge/${owner}/${repo.name}`;
        case 'createdAt': case 'updatedAt': return store.isoOf(repo.seq);
        case 'stargazerCount': case 'forkCount': return 0;
        case 'viewerPermission': return 'ADMIN';
        case 'viewerCanAdminister': return true;
        case 'hasIssuesEnabled': return true;
        case 'defaultBranchRef': {
          const sha = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
          return sha === undefined ? null : ({ __type: 'Ref', name: repo.defaultBranch, sha } satisfies Desc);
        }
        case 'ref': {
          const qualified = String(args.qualifiedName ?? '');
          const branch = qualified.replace(/^refs\/heads\//, '');
          const sha = repo.refs.get(`refs/heads/${branch}`);
          return sha === undefined ? null : ({ __type: 'Ref', name: branch, sha } satisfies Desc);
        }
        case 'issue': {
          const issue = repo.issues.get(Number(args.number));
          return issue === undefined ? null : issueDesc(repo, issue);
        }
        case 'issues': {
          let list = [...repo.issues.values()];
          const states = Array.isArray(args.states) ? args.states.map(String) : null;
          if (states !== null) list = list.filter((issue) => states.includes(issue.state.toUpperCase()));
          const orderBy = (args.orderBy ?? null) as { field?: string; direction?: string } | null;
          if (orderBy !== null && orderBy.direction === 'DESC') list.sort((a, b) => b.seq - a.seq);
          else if (orderBy !== null) list.sort((a, b) => a.seq - b.seq);
          else list.sort((a, b) => a.number - b.number);
          return connection(list.map((issue) => issueDesc(repo, issue)), args);
        }
        case 'pullRequest': {
          const pull = repo.pulls.get(Number(args.number));
          return pull === undefined ? null : pullDesc(repo, pull);
        }
        case 'pullRequests': {
          let list = [...repo.pulls.values()];
          const states = Array.isArray(args.states) ? args.states.map(String) : null;
          if (states !== null) {
            list = list.filter((pull) => states.includes(pull.merged ? 'MERGED' : pull.state.toUpperCase()));
          } else {
            list = list.filter((pull) => pull.state === 'open');
          }
          list.sort((a, b) => a.number - b.number);
          return connection(list.map((pull) => pullDesc(repo, pull)), args);
        }
        case 'labels': {
          const labels = [...repo.labels.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
          return connection(labels.map((label) => ({ __type: 'Label', repo, name: label.name } satisfies Desc)), args);
        }
        default: break;
      }
      break;
    }
    case 'Issue': {
      const { repo, issue } = source;
      switch (name) {
        case 'id': return globalId('Issue', repo.id, issue.number);
        case 'number': return issue.number;
        case 'title': return issue.title;
        case 'body': return issue.body;
        case 'state': return issue.state.toUpperCase();
        case 'closed': return issue.state === 'closed';
        case 'closedAt': return issue.closedSeq !== null ? store.isoOf(issue.closedSeq) : null;
        case 'author': return userDesc(store.ownerOf(repo));
        case 'repository': return repoDesc(repo);
        case 'createdAt': return store.isoOf(issue.seq);
        case 'updatedAt': return store.isoOf(issue.comments.length > 0 ? issue.comments[issue.comments.length - 1]!.seq : issue.seq);
        case 'url': return `http://forge/${store.ownerOf(repo)}/${repo.name}/issues/${issue.number}`;
        case 'viewerCanUpdate': return true;
        case 'stateReason': return null;
        case 'labels': return connection(issue.labels.map((label) => ({ __type: 'Label', repo, name: label } satisfies Desc)), args);
        case 'comments': {
          return connection(issue.comments.map((comment) => ({ __type: 'Comment', repo, id: comment.id, body: comment.body } satisfies Desc)), args);
        }
        default: break;
      }
      break;
    }
    case 'PullRequest': {
      const { repo, pull } = source;
      switch (name) {
        case 'id': return globalId('PullRequest', repo.id, pull.number);
        case 'number': return pull.number;
        case 'title': return pull.title;
        case 'body': return pull.body;
        case 'state': return pull.merged ? 'MERGED' : pull.state.toUpperCase();
        case 'merged': return pull.merged;
        case 'closed': return pull.state === 'closed';
        case 'isDraft': return false;
        case 'mergeable': {
          if (pull.merged) return 'MERGEABLE';
          return pullMergeable(store, repo, pull) ? 'MERGEABLE' : 'CONFLICTING';
        }
        case 'headRefName': return pull.head;
        case 'baseRefName': return pull.base;
        case 'headRef': {
          const sha = repo.refs.get(`refs/heads/${pull.head}`);
          return sha === undefined ? null : ({ __type: 'Ref', name: pull.head, sha } satisfies Desc);
        }
        case 'baseRef': {
          const sha = repo.refs.get(`refs/heads/${pull.base}`);
          return sha === undefined ? null : ({ __type: 'Ref', name: pull.base, sha } satisfies Desc);
        }
        case 'author': return userDesc(store.ownerOf(repo));
        case 'repository': return repoDesc(repo);
        case 'createdAt': return store.isoOf(pull.seq);
        case 'updatedAt': return store.isoOf(pull.mergedSeq ?? pull.seq);
        case 'mergedAt': return pull.mergedSeq !== null ? store.isoOf(pull.mergedSeq) : null;
        case 'mergeCommit': return pull.mergeCommitSha === null ? null : ({ __type: 'Commit', sha: pull.mergeCommitSha } satisfies Desc);
        case 'url': return `http://forge/${store.ownerOf(repo)}/${repo.name}/pull/${pull.number}`;
        case 'files': {
          const files = pullFiles(store, repo, pull).map((file) => ({
            __type: 'Payload',
            payload: 'PullRequestChangedFile',
            fields: {
              path: file.filename,
              additions: file.additions,
              deletions: file.deletions,
              changeType: file.status === 'added' ? 'ADDED' : file.status === 'removed' ? 'DELETED' : 'MODIFIED',
            },
          } satisfies Desc));
          return connection(files, args);
        }
        case 'additions': case 'deletions': case 'changedFiles': {
          const files = pullFiles(store, repo, pull);
          if (name === 'changedFiles') return files.length;
          return files.reduce((sum, file) => sum + (name === 'additions' ? (file.additions as number) : (file.deletions as number)), 0);
        }
        default: break;
      }
      break;
    }
    case 'Ref': {
      switch (name) {
        case 'id': return globalId('Ref', source.name);
        case 'name': return source.name;
        case 'prefix': return 'refs/heads/';
        case 'target': return source.sha === null ? null : ({ __type: 'Commit', sha: source.sha } satisfies Desc);
        default: break;
      }
      break;
    }
    case 'Commit': {
      const commit = store.commitOf(source.sha);
      switch (name) {
        case 'id': return globalId('Commit', source.sha);
        case 'oid': return source.sha;
        case 'abbreviatedOid': return source.sha.slice(0, 7);
        case 'message': return commit?.message ?? '';
        case 'messageHeadline': return (commit?.message ?? '').split('\n')[0] ?? '';
        case 'tree': return commit === null ? null : ({ __type: 'Payload', payload: 'Tree', fields: { oid: commit.tree, abbreviatedOid: commit.tree.slice(0, 7), id: globalId('Tree', commit.tree) } } satisfies Desc);
        default: break;
      }
      break;
    }
    case 'Comment': {
      switch (name) {
        case 'id': return globalId('IssueComment', source.id);
        case 'body': return source.body;
        case 'author': return userDesc(store.ownerOf(source.repo));
        case 'url': return `http://forge/${store.ownerOf(source.repo)}/${source.repo.name}`;
        default: break;
      }
      break;
    }
    case 'Label': {
      const label = source.repo.labels.get(source.name);
      switch (name) {
        case 'id': return globalId('Label', source.repo.id, source.name);
        case 'name': return source.name;
        case 'color': return label?.color ?? 'ededed';
        case 'description': return label?.description ?? null;
        default: break;
      }
      break;
    }
    case 'Type': {
      switch (name) {
        case 'name': return source.name;
        case 'kind': return ENUM_VALUES[source.name] !== undefined ? 'ENUM' : 'OBJECT';
        case 'description': return null;
        case 'fields': {
          const fields = TYPE_FIELDS[source.name];
          if (fields === undefined) return null;
          const includeDeprecated = args.includeDeprecated === true;
          void includeDeprecated;
          return fields.map((fieldName) => ({ __type: 'TypeField', name: fieldName } satisfies Desc));
        }
        case 'enumValues': {
          const values = ENUM_VALUES[source.name];
          if (values === undefined) return null;
          return values.map((value) => ({ __type: 'EnumValue', name: value } satisfies Desc));
        }
        case 'possibleTypes': return [];
        case 'inputFields': return [];
        case 'ofType': return null;
        case 'specifiedByURL': return null;
        default: break;
      }
      break;
    }
    case 'TypeField': {
      if (name === 'name') return source.name;
      if (name === 'description') return null;
      if (name === 'isDeprecated') return false;
      if (name === 'deprecationReason') return null;
      if (name === 'args') return [];
      if (name === 'type') return { __type: 'Type', name: 'String' } satisfies Desc;
      break;
    }
    case 'EnumValue': {
      if (name === 'name') return source.name;
      if (name === 'description') return null;
      if (name === 'isDeprecated') return false;
      if (name === 'deprecationReason') return null;
      break;
    }
    case 'Connection': {
      switch (name) {
        case 'nodes': return source.items;
        case 'edges': return source.items.map((item, index) => ({ __type: 'Edge', node: item, cursor: cursorOf(index) } satisfies Desc));
        case 'pageInfo': return {
          __type: 'PageInfo',
          hasNextPage: source.hasNextPage,
          hasPreviousPage: false,
          startCursor: source.items.length > 0 ? cursorOf(0) : null,
          endCursor: source.endCursor,
        } satisfies Desc;
        case 'totalCount': return source.total;
        default: break;
      }
      break;
    }
    case 'PageInfo': {
      switch (name) {
        case 'hasNextPage': return source.hasNextPage;
        case 'hasPreviousPage': return source.hasPreviousPage;
        case 'startCursor': return source.startCursor;
        case 'endCursor': return source.endCursor;
        default: break;
      }
      break;
    }
    case 'Edge': {
      if (name === 'node') return source.node;
      if (name === 'cursor') return source.cursor;
      break;
    }
    case 'Payload': {
      if (name in source.fields) return source.fields[name];
      if (name === 'clientMutationId') return null;
      break;
    }
  }

  ctx.errors.push({ message: `Field '${name}' doesn't exist on type '${typeName}'` });
  return null;
}

function nodeById(ctx: Ctx, id: string): Desc | null {
  const parts = parseGlobalId(id);
  if (parts === null) return null;
  const [kind, ...rest] = parts;
  switch (kind) {
    case 'Repository': {
      const repo = ctx.store.repoById(Number(rest[0]));
      return repo === undefined ? null : repoDesc(repo);
    }
    case 'Issue': {
      const repo = ctx.store.repoById(Number(rest[0]));
      const issue = repo?.issues.get(Number(rest[1]));
      return repo !== undefined && issue !== undefined ? issueDesc(repo, issue) : null;
    }
    case 'PullRequest': {
      const repo = ctx.store.repoById(Number(rest[0]));
      const pull = repo?.pulls.get(Number(rest[1]));
      return repo !== undefined && pull !== undefined ? pullDesc(repo, pull) : null;
    }
    case 'User': return userDesc(rest.join(':'));
    default: return null;
  }
}

function repoByGlobalId(ctx: Ctx, id: unknown): RepoRec | null {
  const parts = typeof id === 'string' ? parseGlobalId(id) : null;
  if (parts === null || parts[0] !== 'Repository') return null;
  return ctx.store.repoById(Number(parts[1])) ?? null;
}

function resolveMutation(ctx: Ctx, name: string, args: Record<string, unknown>): Raw {
  const store = ctx.store;
  const input = (args.input ?? {}) as Record<string, unknown>;
  const payload = (payloadName: string, fields: Record<string, unknown>): Desc => ({
    __type: 'Payload',
    payload: payloadName,
    fields: { ...fields, clientMutationId: typeof input.clientMutationId === 'string' ? input.clientMutationId : null },
  });

  switch (name) {
    case 'createIssue': {
      const repo = repoByGlobalId(ctx, input.repositoryId);
      if (repo === null) { ctx.errors.push({ message: 'Repository not found' }); return payload('CreateIssuePayload', { issue: null }); }
      const issue = createIssueRecord(store, repo, {
        title: String(input.title ?? ''),
        body: String(input.body ?? ''),
      });
      return payload('CreateIssuePayload', { issue: issueDesc(repo, issue) });
    }
    case 'closeIssue': {
      const parts = typeof input.issueId === 'string' ? parseGlobalId(input.issueId) : null;
      const repo = parts !== null && parts[0] === 'Issue' ? store.repoById(Number(parts[1])) : undefined;
      const issue = repo?.issues.get(Number(parts?.[2]));
      if (repo === undefined || issue === undefined) { ctx.errors.push({ message: 'Issue not found' }); return payload('CloseIssuePayload', { issue: null }); }
      if (issue.state !== 'closed') {
        issue.state = 'closed';
        issue.closedSeq = store.nextSeq();
      }
      return payload('CloseIssuePayload', { issue: issueDesc(repo, issue) });
    }
    case 'createPullRequest': {
      const repo = repoByGlobalId(ctx, input.repositoryId);
      if (repo === null) { ctx.errors.push({ message: 'Repository not found' }); return payload('CreatePullRequestPayload', { pullRequest: null }); }
      const head = String(input.headRefName ?? '');
      const base = String(input.baseRefName ?? repo.defaultBranch);
      if (!repo.refs.has(`refs/heads/${head}`) || !repo.refs.has(`refs/heads/${base}`)) {
        ctx.errors.push({ message: 'Invalid head or base ref' });
        return payload('CreatePullRequestPayload', { pullRequest: null });
      }
      const pull = createPullRecord(store, repo, {
        title: String(input.title ?? ''),
        body: String(input.body ?? ''),
        head,
        base,
      });
      return payload('CreatePullRequestPayload', { pullRequest: pullDesc(repo, pull) });
    }
    case 'mergePullRequest': {
      const parts = typeof input.pullRequestId === 'string' ? parseGlobalId(input.pullRequestId) : null;
      const repo = parts !== null && parts[0] === 'PullRequest' ? store.repoById(Number(parts[1])) : undefined;
      const pull = repo?.pulls.get(Number(parts?.[2]));
      if (repo === undefined || pull === undefined) { ctx.errors.push({ message: 'Pull request not found' }); return payload('MergePullRequestPayload', { pullRequest: null }); }
      const method = String(input.mergeMethod ?? 'MERGE').toLowerCase();
      const result = performMerge(store, repo, pull, method);
      if (!('sha' in result)) ctx.errors.push({ message: 'Pull Request is not mergeable' });
      return payload('MergePullRequestPayload', { pullRequest: pullDesc(repo, pull) });
    }
    case 'addComment': {
      const parts = typeof input.subjectId === 'string' ? parseGlobalId(input.subjectId) : null;
      const repo = parts !== null && parts[0] === 'Issue' ? store.repoById(Number(parts[1])) : undefined;
      const issue = repo?.issues.get(Number(parts?.[2]));
      if (repo === undefined || issue === undefined) { ctx.errors.push({ message: 'Subject not found' }); return payload('AddCommentPayload', { commentEdge: null }); }
      const comment = { id: store.nextCommentId(), body: String(input.body ?? ''), seq: store.nextSeq() };
      issue.comments.push(comment);
      const node: Desc = { __type: 'Comment', repo, id: comment.id, body: comment.body };
      const edge: Desc = { __type: 'Edge', node, cursor: cursorOf(issue.comments.length - 1) };
      return payload('AddCommentPayload', { commentEdge: edge });
    }
    default:
      ctx.errors.push({ message: `Field '${name}' doesn't exist on type 'Mutation'` });
      return null;
  }
}

// ------------------------------------------------------------------ completion

function completeValue(ctx: Ctx, typeName: string, value: Raw, selectionSet: SelectionNode[] | null): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((entry) => completeValue(ctx, typeName, entry, selectionSet));
  if (isDesc(value)) {
    if (selectionSet === null) return null;
    return executeSelectionSet(ctx, value.__type, value, selectionSet);
  }
  return value;
}

function executeSelectionSet(ctx: Ctx, typeName: string, source: Desc | null, selections: SelectionNode[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const expanded: FieldNode[] = [];
  const expand = (nodes: SelectionNode[], currentType: string): void => {
    for (const node of nodes) {
      if (node.kind === 'field') expanded.push(node);
      else if (node.kind === 'inline') {
        if (node.typeCondition === null || node.typeCondition === currentType) expand(node.selectionSet, currentType);
      } else {
        const fragment = ctx.fragments.get(node.name);
        if (fragment !== undefined && (fragment.typeCondition === null || fragment.typeCondition === currentType)) {
          expand(fragment.selectionSet, currentType);
        }
      }
    }
  };
  expand(selections, typeName);
  for (const field of expanded) {
    const key = field.alias ?? field.name;
    const raw = resolveField(ctx, typeName, source, field);
    out[key] = completeValue(ctx, typeName, raw, field.selectionSet);
  }
  return out;
}

// ------------------------------------------------------------------ entry

function runOperation(store: Store, entry: unknown): Record<string, unknown> {
  if (typeof entry !== 'object' || entry === null) return { errors: [{ message: 'Invalid GraphQL request' }] };
  const request = entry as Record<string, unknown>;
  const query = typeof request.query === 'string' ? request.query : '';
  const variables = (typeof request.variables === 'object' && request.variables !== null ? request.variables : {}) as Record<string, unknown>;
  let document: Document;
  try {
    document = new Parser(lex(query)).parseDocument();
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : 'Parse error' }] };
  }
  const operationName = typeof request.operationName === 'string' ? request.operationName : null;
  const operation = document.operations.find((op) => operationName === null || op.name === operationName) ?? document.operations[0];
  if (operation === undefined) return { errors: [{ message: 'No operation found' }] };
  const ctx: Ctx = { store, variables, fragments: document.fragments, errors: [] };
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelectionSet(ctx, rootType, null, operation.selectionSet);
  const out: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) out.errors = ctx.errors;
  return out;
}

/** Answer one GraphQL request body (a single operation object, or an array for batching). */
export function handleGraphQL(store: Store, bodyText: string): GraphQLResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return { status: 400, json: { errors: [{ message: 'Request body is not valid JSON' }] } };
  }
  if (Array.isArray(parsed)) {
    return { status: 200, json: parsed.map((entry) => runOperation(store, entry)) };
  }
  return { status: 200, json: runOperation(store, parsed) };
}
