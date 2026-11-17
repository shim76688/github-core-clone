// app.ts — the forge's HTTP server: one process, one shared Store, four surfaces.
//   git smart HTTP   /<owner>/<repo>.git/info/refs, git-upload-pack, git-receive-pack
//   REST v3          /api/v3/...
//   GraphQL v4       /api/graphql
//   MCP              /mcp
// plus the env's health probe. main.ts owns the lifecycle and stays as the starter shipped it.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { advertiseRefs, advertiseV2, handleFetchV0, handleFetchV2, handleLsRefs, handleReceivePack, pktLine, PKT_FLUSH } from './git.ts';
import { handleRest, type RestRequest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMCP } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 256 * 1024 * 1024;

let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return `forge-${requestCounter.toString(16).padStart(8, '0')}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = body === null || body === undefined ? '' : `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': nextRequestId(),
    ...headers,
  });
  res.end(text);
}

function sendBuffer(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length, 'x-github-request-id': nextRequestId() });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      parts.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });
}

/** Whether the request carries the shop token (Bearer, or Basic with the token as password). */
function authed(store: Store, req: IncomingMessage): boolean {
  const token = store.token;
  if (token === '') return true;
  const header = req.headers.authorization;
  if (typeof header !== 'string') return false;
  if (header === `Bearer ${token}`) return true;
  if (header.startsWith('Basic ')) {
    try {
      const decoded = Buffer.from(header.slice('Basic '.length), 'base64').toString('utf8');
      const password = decoded.slice(decoded.indexOf(':') + 1);
      if (password === token) return true;
    } catch {
      // fall through
    }
  }
  return false;
}

function pathOf(req: IncomingMessage): { pathname: string; searchParams: URLSearchParams } {
  try {
    const url = new URL(req.url ?? '/', 'http://entry');
    return { pathname: url.pathname, searchParams: url.searchParams };
  } catch {
    return { pathname: '/', searchParams: new URLSearchParams() };
  }
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const store = new Store();
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        await route(store, req, res);
      } catch (err) {
        process.stderr.write(`[forge] request failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
        if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' });
        else res.end();
      }
    })();
  });
}

async function route(store: Store, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { pathname, searchParams } = pathOf(req);
  const method = req.method ?? 'GET';

  if (method === 'GET' && pathname === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  // ------------------------------------------------------------ REST v3
  if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
    if (method === 'GET' && (pathname === '/api/v3' || pathname === '/api/v3/')) {
      sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
      return;
    }
    if (!authed(store, req)) {
      sendJson(res, 401, { message: 'Bad credentials' });
      return;
    }
    const bodyBuffer = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
    let body: Record<string, unknown> | null = null;
    if (bodyBuffer.length > 0) {
      try {
        const parsed: unknown = JSON.parse(bodyBuffer.toString('utf8'));
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
        else {
          sendJson(res, 400, { message: 'Problems parsing JSON' });
          return;
        }
      } catch {
        sendJson(res, 400, { message: 'Problems parsing JSON' });
        return;
      }
    }
    const segments = pathname
      .slice('/api/v3'.length)
      .split('/')
      .filter((part) => part !== '')
      .map((part) => decodeURIComponent(part));
    const restRequest: RestRequest = {
      method,
      segments,
      query: searchParams,
      body,
      host: req.headers.host ?? 'localhost',
      rawPath: pathname,
    };
    const answer = handleRest(store, restRequest);
    sendJson(res, answer.status, answer.json, answer.headers ?? {});
    return;
  }

  // ------------------------------------------------------------ GraphQL v4
  if (pathname === '/api/graphql') {
    if (!authed(store, req)) {
      sendJson(res, 401, { message: 'Bad credentials' });
      return;
    }
    if (method !== 'POST') {
      sendJson(res, 405, { errors: [{ message: 'Method not allowed' }] });
      return;
    }
    const bodyBuffer = await readBody(req);
    const answer = handleGraphQL(store, bodyBuffer.toString('utf8'));
    sendJson(res, answer.status, answer.json);
    return;
  }

  // ------------------------------------------------------------ MCP
  if (pathname === '/mcp') {
    if (method !== 'POST') {
      sendJson(res, 405, { message: 'Method Not Allowed' });
      return;
    }
    if (!authed(store, req)) {
      sendJson(res, 401, { message: 'Bad credentials' });
      return;
    }
    const bodyBuffer = await readBody(req);
    const answer = handleMCP(store, bodyBuffer.toString('utf8'));
    if (answer.json === null) {
      res.writeHead(answer.status, { 'x-github-request-id': nextRequestId() });
      res.end();
      return;
    }
    sendJson(res, answer.status, answer.json);
    return;
  }

  // ------------------------------------------------------------ git smart HTTP
  const gitMatch = /^\/([^/]+)\/([^/]+?)\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(pathname);
  if (gitMatch !== null) {
    const owner = decodeURIComponent(gitMatch[1]!);
    const repoName = decodeURIComponent(gitMatch[2]!).replace(/\.git$/, '');
    const endpoint = gitMatch[3]!;
    if (!authed(store, req)) {
      res.writeHead(401, { 'www-authenticate': 'Basic realm="forge"', 'x-github-request-id': nextRequestId() });
      res.end();
      return;
    }
    const repo = store.findRepo(owner, repoName);
    if (repo === null) {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    if (endpoint === 'info/refs' && method === 'GET') {
      const service = searchParams.get('service');
      if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
        sendJson(res, 403, { message: 'Unsupported service' });
        return;
      }
      const protocol = req.headers['git-protocol'];
      const version2 = typeof protocol === 'string' && protocol.includes('version=2');
      const advertisement = version2
        ? advertiseV2(repo)
        : Buffer.concat([pktLine(`# service=${service}`), PKT_FLUSH, advertiseRefs(store, repo, service)]);
      sendBuffer(res, 200, advertisement, `application/x-${service}-advertisement`);
      return;
    }
    if (endpoint === 'git-upload-pack' && method === 'POST') {
      const body = await readBody(req);
      const firstLine = body.toString('utf8', 0, Math.min(body.length, 4096));
      let answer: Buffer;
      if (firstLine.includes('command=ls-refs')) answer = handleLsRefs(store, repo, body);
      else if (firstLine.includes('command=fetch')) answer = handleFetchV2(store, body);
      else answer = handleFetchV0(store, body);
      sendBuffer(res, 200, answer, 'application/x-git-upload-pack-result');
      return;
    }
    if (endpoint === 'git-receive-pack' && method === 'POST') {
      const body = await readBody(req);
      const outcome = handleReceivePack(store, repo, body);
      sendBuffer(res, outcome.status, outcome.body, 'application/x-git-receive-pack-result');
      return;
    }
    sendJson(res, 405, { message: 'Method Not Allowed' });
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}
