// mcp.ts — the Model Context Protocol endpoint (POST /mcp), JSON-RPC 2.0 over Streamable HTTP:
// discovery (2026-07-28), the legacy initialize handshake, and tools backed by the shared Store,
// so an object created over MCP is the same object REST and GraphQL read.

import type { Store } from './store.ts';
import {
  commentJson,
  createIssueRecord,
  createPullRecord,
  globalId,
  issueJson,
  performMerge,
  pullJson,
  repoJson,
} from './rest.ts';

export interface McpResponse {
  status: number;
  json: unknown; // null means: no body (a notification acknowledgement)
}

export const MCP_TOOLS: readonly Record<string, unknown>[] = Object.freeze([
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch.' },
        base: { type: 'string', description: 'The base branch.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'number', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
  {
    name: 'get_issue',
    description: 'Get one issue of a repository by its number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        issue_number: { type: 'number', description: 'The issue number.' },
      },
      required: ['owner', 'repo', 'issue_number'],
    },
  },
  {
    name: 'list_pull_requests',
    description: 'List the pull requests of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
]);

const SERVER_INFO = { name: 'forge', version: '1.0.0' };

function rpcResult(id: unknown, result: unknown): McpResponse {
  return { status: 200, json: { jsonrpc: '2.0', id, result } };
}

function rpcError(id: unknown, code: number, message: string, status = 200): McpResponse {
  return { status, json: { jsonrpc: '2.0', id, error: { code, message } } };
}

/** Answer one MCP request body. Authentication is the caller's job (it precedes parsing). */
export function handleMCP(store: Store, bodyText: string): McpResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return rpcError(null, -32700, 'Parse error', 400);
  }
  if (Array.isArray(parsed)) {
    const answers = parsed.map((entry) => handleOne(store, entry));
    return { status: 200, json: answers.map((answer) => answer.json).filter((entry) => entry !== null) };
  }
  return handleOne(store, parsed);
}

function handleOne(store: Store, parsed: unknown): McpResponse {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return rpcError(null, -32600, 'Invalid Request', 400);
  }
  const request = parsed as Record<string, unknown>;
  const id = request.id ?? null;
  const method = typeof request.method === 'string' ? request.method : '';
  if (id === null && method.startsWith('notifications/')) return { status: 202, json: null };

  switch (method) {
    case 'server/discover':
      return rpcResult(id, {
        supportedVersions: ['2026-07-28', '2025-11-25'],
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    case 'initialize': {
      const params = (request.params ?? {}) as Record<string, unknown>;
      const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25';
      return rpcResult(id, { protocolVersion: offered, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
    }
    case 'tools/list':
      return rpcResult(id, { tools: MCP_TOOLS });
    case 'tools/call': {
      const params = (request.params ?? {}) as Record<string, unknown>;
      const toolName = typeof params.name === 'string' ? params.name : '';
      const args = (typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {}) as Record<string, unknown>;
      const outcome = callTool(store, toolName, args);
      if ('__unknownTool' in outcome) return rpcError(id, -32602, `Unknown tool: ${toolName}`);
      if ('__invalidParams' in outcome) return rpcError(id, -32602, String(outcome.__invalidParams));
      return rpcResult(id, outcome);
    }
    case 'ping':
      return rpcResult(id, {});
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

// ------------------------------------------------------------------ tool calls

interface ToolOutcome {
  result?: unknown;
  error?: { code: number; message: string };
  toolError?: string;
}

function toolResult(value: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value as Record<string, unknown>,
    isError: false,
  };
}

function toolFailure(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

const TOOL_REQUIRED: Record<string, string[]> = {
  create_repo: ['name'],
  get_repo: ['owner', 'repo'],
  create_issue: ['owner', 'repo', 'title'],
  list_issues: ['owner', 'repo'],
  create_pull_request: ['owner', 'repo', 'title', 'head', 'base'],
  merge_pull_request: ['owner', 'repo', 'pull_number'],
  get_issue: ['owner', 'repo', 'issue_number'],
  list_pull_requests: ['owner', 'repo'],
};

function callTool(store: Store, toolName: string, args: Record<string, unknown>): Record<string, unknown> {
  const required = TOOL_REQUIRED[toolName];
  if (required === undefined) {
    // Unknown tool: the caller turns this sentinel into a -32602 below via callToolOrError.
    return { __unknownTool: toolName } as unknown as Record<string, unknown>;
  }
  for (const key of required) {
    if (args[key] === undefined || args[key] === null || args[key] === '') {
      return { __invalidParams: `Missing required argument: ${key}` } as unknown as Record<string, unknown>;
    }
  }
  const str = (key: string): string => String(args[key] ?? '');
  const findRepo = () => store.findRepo(str('owner'), str('repo'));

  switch (toolName) {
    case 'create_repo': {
      const repo = store.createRepo(str('name'), args.private === true, typeof args.description === 'string' ? args.description : '');
      if (repo === null) return toolFailure(`Repository "${str('name')}" already exists`);
      return toolResult(repoJson(store, repo));
    }
    case 'get_repo': {
      const repo = findRepo();
      if (repo === null) return toolFailure(`Repository ${str('owner')}/${str('repo')} not found`);
      return toolResult(repoJson(store, repo));
    }
    case 'create_issue': {
      const repo = findRepo();
      if (repo === null) return toolFailure(`Repository ${str('owner')}/${str('repo')} not found`);
      const issue = createIssueRecord(store, repo, {
        title: str('title'),
        body: typeof args.body === 'string' ? args.body : '',
      });
      return toolResult(issueJson(store, repo, issue));
    }
    case 'list_issues': {
      const repo = findRepo();
      if (repo === null) return toolFailure(`Repository ${str('owner')}/${str('repo')} not found`);
      const state = typeof args.state === 'string' ? args.state : 'open';
      const all = [...repo.issues.values()].sort((a, b) => a.number - b.number);
      const filtered = state === 'all' ? all : all.filter((issue) => issue.state === state);
      return toolResult(filtered.map((issue) => issueJson(store, repo, issue)));
    }
    case 'create_pull_request': {
      const repo = findRepo();
      if (repo === null) return toolFailure(`Repository ${str('owner')}/${str('repo')} not found`);
      const head = str('head').includes(':') ? str('head').split(':').pop()! : str('head');
      const base = str('base');
      if (!repo.refs.has(`refs/heads/${head}`)) return toolFailure(`Head branch "${head}" does not exist`);
      if (!repo.refs.has(`refs/heads/${base}`)) return toolFailure(`Base branch "${base}" does not exist`);
      const pull = createPullRecord(store, repo, {
        title: str('title'),
        body: typeof args.body === 'string' ? args.body : '',
        head,
        base,
      });
      return toolResult(pullJson(store, repo, pull));
    }
    case 'merge_pull_request': {
      const repo = findRepo();
      if (repo === null) return toolFailure(`Repository ${str('owner')}/${str('repo')} not found`);
      const pull = repo.pulls.get(Number(args.pull_number));
      if (pull === undefined) return toolFailure(`Pull request #${String(args.pull_number)} not found`);
      const result = performMerge(store, repo, pull, 'merge');
      if (!('sha' in result)) return toolFailure('Pull Request is not mergeable');
      return toolResult({ ...pullJson(store, repo, pull), merge_commit_sha: result.sha });
    }
    case 'get_issue': {
      const repo = findRepo();
      if (repo === null) return toolFailure(`Repository ${str('owner')}/${str('repo')} not found`);
      const issue = repo.issues.get(Number(args.issue_number));
      if (issue === undefined) return toolFailure(`Issue #${String(args.issue_number)} not found`);
      return toolResult(issueJson(store, repo, issue));
    }
    case 'list_pull_requests': {
      const repo = findRepo();
      if (repo === null) return toolFailure(`Repository ${str('owner')}/${str('repo')} not found`);
      const state = typeof args.state === 'string' ? args.state : 'open';
      const all = [...repo.pulls.values()].sort((a, b) => a.number - b.number);
      const filtered = state === 'all' ? all : all.filter((pull) => pull.state === state);
      return toolResult(filtered.map((pull) => pullJson(store, repo, pull)));
    }
    default:
      return toolFailure(`Unknown tool: ${toolName}`);
  }
}
