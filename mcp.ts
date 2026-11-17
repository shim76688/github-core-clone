// mcp.ts — the Model Context Protocol endpoint (POST /mcp), JSON-RPC 2.0 over Streamable HTTP.
// v1: discovery (2026-07-28), the legacy initialize handshake, and the tool list; the tool calls
// themselves land in the next revision of this file.

import type { Store } from './store.ts';

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
  void store;
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return rpcError(null, -32700, 'Parse error', 400);
  }
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
    case 'ping':
      return rpcResult(id, {});
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}
