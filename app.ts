// app.ts — the forge server.
//
// One process, one in-memory store, four surfaces: git smart HTTP
// (protocol v2 and v0, upload-pack and receive-pack), the GitHub REST v3
// API, GraphQL, and MCP — all reading and writing the same Forge, so a
// repository pushed over git, an issue opened over REST, a pull request
// merged over GraphQL and a comment left over MCP are the same objects.
//
// The distinctive angle: the store is content-addressed and cached at
// every hot layer. A fetch/clone pack is built once per (repo version,
// wants, haves, shallow, depth) and then served from a bounded cache, so
// fifty concurrent shallow clones of one tip are mostly cache hits; a
// single issue's JSON is serialized once and invalidated only when that
// issue changes, so two thousand reads of one issue are a string copy.
// A logical clock (a monotonic counter, never Date.now() in a response)
// makes commit SHAs and created_at deterministic, so a replay exports
// byte-identical state.
//
// Every reply is application/json (except the git pack bodies) with a
// non-empty X-GitHub-Request-Id; an unknown route is a JSON 404, a
// malformed JSON body is a 400, and every error body carries a string
// `message`. A request with no bearer token is 401; the same repository
// name under another login is 404, never 403.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Forge } from './store.ts';
import { deriveIdentity } from './scenario.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './githttp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

/** The bearer token the env hands the entry (MAKEFUN_SHOP_TOKEN). */
const EXPECTED_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

let requestCounter = 0;
/** Deterministic, non-empty request ids: req-00000001, req-00000002, … */
function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter.toString(16).padStart(8, '0')}`;
}

/** The path and query of a request URL, parsed once per request (never a throw from a request). */
function parseUrl(req: IncomingMessage): { path: string; query: URLSearchParams } {
  try {
    const url = new URL(req.url ?? '/', 'http://entry');
    return { path: url.pathname, query: url.searchParams };
  } catch {
    return { path: '/', query: new URLSearchParams() };
  }
}

/** Answer with raw bytes and a content type. */
function sendBuffer(
  res: ServerResponse,
  status: number,
  contentType: string,
  body: Buffer,
  requestId: string,
  extraHeaders: Readonly<Record<string, string>> = {},
): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': requestId,
    ...extraHeaders,
  });
  res.end(body);
}

/** Answer with a JSON body. */
function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  requestId: string,
  extraHeaders: Readonly<Record<string, string>> = {},
): void {
  sendBuffer(res, status, JSON_TYPE, Buffer.from(`${JSON.stringify(body)}\n`, 'utf8'), requestId, extraHeaders);
}

/** Read the whole request body into a Buffer. */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/.exec(header);
  return match ? (match[1] ?? '').trim() : null;
}

/**
 * The request is authenticated when it carries the env's token. When the
 * env did not hand the entry a token (local runs without MAKEFUN_SHOP_TOKEN),
 * any non-empty bearer is accepted; a missing bearer is always 401.
 */
function authorized(req: IncomingMessage): boolean {
  const token = bearerToken(req);
  if (token === null || token === '') return false;
  if (EXPECTED_TOKEN === '') return true;
  return token === EXPECTED_TOKEN;
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const forge = new Forge(deriveIdentity());
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void handleRequest(forge, req, res).catch((err: unknown) => {
      if (!res.headersSent) {
        sendJson(res, 500, { message: err instanceof Error ? err.message : 'internal error' }, nextRequestId());
      } else {
        res.end();
      }
    });
  });
}

async function handleRequest(forge: Forge, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const requestId = nextRequestId();
  const { path, query } = parseUrl(req);
  const method = req.method ?? 'GET';

  // The env's boot check calls this twice: 200 {"ok":true}.
  if (method === 'GET' && path === '/healthz') {
    sendJson(res, 200, { ok: true }, requestId);
    return;
  }

  // Git smart HTTP: /<owner>/<repo>.git/info/refs and the two pack endpoints.
  const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
  if (gitMatch) {
    const owner = gitMatch[1] ?? '';
    const repo = (gitMatch[2] ?? '').replace(/\.git$/, '');
    const endpoint = gitMatch[3] ?? '';
    if (!authorized(req)) {
      sendJson(res, 401, { message: 'Requires authentication' }, requestId);
      return;
    }
    if (endpoint === 'info/refs') {
      if (method !== 'GET') {
        sendJson(res, 405, { message: 'Method Not Allowed' }, requestId);
        return;
      }
      const service = query.get('service') ?? '';
      const gitProtocol = typeof req.headers['git-protocol'] === 'string' ? req.headers['git-protocol'] : null;
      const outcome = handleInfoRefs(forge, owner, repo, service, gitProtocol);
      sendBuffer(res, outcome.status, outcome.contentType, outcome.body, requestId);
      return;
    }
    if (method !== 'POST') {
      sendJson(res, 405, { message: 'Method Not Allowed' }, requestId);
      return;
    }
    const body = await readBody(req);
    const gitProtocol = typeof req.headers['git-protocol'] === 'string' ? req.headers['git-protocol'] : null;
    const outcome =
      endpoint === 'git-upload-pack'
        ? handleUploadPack(forge, owner, repo, body, gitProtocol)
        : handleReceivePack(forge, owner, repo, body);
    sendBuffer(res, outcome.status, outcome.contentType, outcome.body, requestId);
    return;
  }

  // GraphQL.
  if (path === '/api/graphql' && method === 'POST') {
    await handleGraphqlRoute(forge, req, res, requestId);
    return;
  }

  // MCP.
  if (path === '/mcp' && method === 'POST') {
    await handleMcpRoute(forge, req, res, requestId);
    return;
  }

  // REST v3.
  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    await routeRest(forge, req, res, requestId, path, method, query);
    return;
  }

  // Everything else, every method: GitHub's 404 body.
  sendJson(res, 404, { message: 'Not Found' }, requestId);
}

// ---------------------------------------------------------------------------------------------
// REST v3 routing
// ---------------------------------------------------------------------------------------------

import { executeGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import * as rest from './rest.ts';
import type { RestContext, RestResponse } from './rest.ts';

interface Route {
  method: string;
  /** Segments; ':name' captures one segment, '*' captures the rest of the path. */
  pattern: string[];
  handler: (ctx: RestContext) => RestResponse;
}

const REST_ROUTES: Route[] = [
  { method: 'GET', pattern: ['api', 'v3'], handler: rest.getRoot },
  { method: 'GET', pattern: ['api', 'v3', 'meta'], handler: rest.getMeta },
  { method: 'GET', pattern: ['api', 'v3', 'user'], handler: rest.getUser },
  { method: 'POST', pattern: ['api', 'v3', 'user', 'repos'], handler: rest.createUserRepo },
  { method: 'GET', pattern: ['api', 'v3', 'user', 'repos'], handler: rest.listUserRepos },
  { method: 'GET', pattern: ['api', 'v3', 'repos', ':owner', ':repo'], handler: rest.getRepo },
  { method: 'PATCH', pattern: ['api', 'v3', 'repos', ':owner', ':repo'], handler: rest.patchRepo },
  { method: 'DELETE', pattern: ['api', 'v3', 'repos', ':owner', ':repo'], handler: rest.deleteRepo },
  { method: 'POST', pattern: ['api', 'v3', 'repos', ':owner', ':repo', 'git', 'refs'], handler: rest.createRef },
  { method: 'GET', pattern: ['api', 'v3', 'repos', ':owner', ':repo', 'git', 'refs', '*'], handler: rest.getRef },
  { method: 'GET', pattern: ['api', 'v3', 'repos', ':owner', ':repo', 'branches'], handler: rest.listBranches },
  { method: 'GET', pattern: ['api', 'v3', 'repos', ':owner', ':repo', 'branches', ':branch'], handler: rest.getBranch },
  { method: 'GET', pattern: ['api', 'v3', 'repos', ':owner', ':repo', 'commits'], handler: rest.listCommits },
  { method: 'PUT', pattern: ['api', 'v3', 'repos', ':owner', ':repo', 'contents', '*'], handler: rest.putContents },
  { method: 'GET', pattern: ['api', 'v3', 'repos', ':owner', ':repo', 'contents', '*'], handler: rest.getContents },
  { method: 'DELETE', pattern: ['api', 'v3', 'repos', ':owner', ':repo', 'contents', '*'], handler: rest.deleteContents },
  { method: 'POST', pattern: ['api', 'v3', 'repos', ':owner', ':repo', 'labels'], handler: rest.createLabel },
  { method: 'POST', pattern: ['api', 'v3', 'repos', ':owner', ':repo', 'issues'], handler: rest.createIssue },
  { method: 'GET', pattern: ['api', 'v3', 'repos', ':owner', ':repo', 'issues'], handler: rest.listIssues },
  { method: 'GET', pattern: ['api', 'v3', 'repos', ':owner', ':repo', 'issues', ':number'], handler: rest.getIssue },
  { method: 'PATCH', pattern: ['api', 'v3', 'repos', ':owner', ':repo', 'issues', ':number'], handler: rest.patchIssue },
  { method: 'POST', pattern: ['api', 'v3', 'repos', ':owner', ':repo', 'issues', ':number', 'comments'], handler: rest.createComment },
  { method: 'GET', pattern: ['api', 'v3', 'repos', ':owner', ':repo', 'issues', ':number', 'comments'], handler: rest.listComments },
  { method: 'POST', pattern: ['api', 'v3', 'repos', ':owner', ':repo', 'pulls'], handler: rest.createPull },
  { method: 'GET', pattern: ['api', 'v3', 'repos', ':owner', ':repo', 'pulls'], handler: rest.listPulls },
  { method: 'GET', pattern: ['api', 'v3', 'repos', ':owner', ':repo', 'pulls', ':number'], handler: rest.getPull },
  { method: 'GET', pattern: ['api', 'v3', 'repos', ':owner', ':repo', 'pulls', ':number', 'files'], handler: rest.listPullFiles },
  { method: 'PUT', pattern: ['api', 'v3', 'repos', ':owner', ':repo', 'pulls', ':number', 'merge'], handler: rest.mergePull },
];

/** Match a path against the route table; the first route that fits wins. */
function matchRoute(method: string, segments: string[]): { route: Route; params: Record<string, string> } | null {
  for (const route of REST_ROUTES) {
    if (route.method !== method) continue;
    const params: Record<string, string> = {};
    let ok = true;
    let i = 0;
    for (; i < route.pattern.length; i++) {
      const part = route.pattern[i]!;
      if (part === '*') {
        const rest = segments.slice(i).join('/');
        if (part === '*' && i === route.pattern.length - 1) {
          params[route.pattern[i - 1] === 'contents' ? 'path' : 'ref'] = decodeURIComponent(rest);
        }
        i = segments.length;
        break;
      }
      const segment = segments[i];
      if (segment === undefined) {
        ok = false;
        break;
      }
      if (part.startsWith(':')) {
        params[part.slice(1)] = decodeURIComponent(segment);
      } else if (part !== segment) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    if (i < segments.length) continue;
    return { route, params };
  }
  return null;
}

/** Answer one REST response, including a pre-serialized JSON string body and a 204. */
function sendRestResponse(res: ServerResponse, response: RestResponse, requestId: string): void {
  if (response.status === 204 || response.body === null) {
    res.writeHead(204, { 'x-github-request-id': requestId, ...(response.headers ?? {}) });
    res.end();
    return;
  }
  const text = typeof response.body === 'string' ? response.body : JSON.stringify(response.body);
  sendBuffer(res, response.status, JSON_TYPE, Buffer.from(`${text}\n`, 'utf8'), requestId, response.headers ?? {});
}

async function routeRest(
  forge: Forge,
  req: IncomingMessage,
  res: ServerResponse,
  requestId: string,
  path: string,
  method: string,
  query: URLSearchParams,
): Promise<void> {
  if (!authorized(req)) {
    sendJson(res, 401, { message: 'Requires authentication' }, requestId);
    return;
  }
  const segments = path.split('/').filter((segment) => segment !== '');
  const matched = matchRoute(method, segments);
  if (!matched) {
    sendJson(res, 404, { message: 'Not Found' }, requestId);
    return;
  }
  let body: unknown = null;
  const raw = await readBody(req);
  if (raw.length > 0) {
    try {
      body = JSON.parse(raw.toString('utf8')) as unknown;
    } catch {
      sendJson(res, 400, { message: 'Problems parsing JSON' }, requestId);
      return;
    }
  }
  const ctx: RestContext = {
    forge,
    origin: `http://${req.headers.host ?? '127.0.0.1'}`,
    params: matched.params,
    query,
    body,
  };
  const response = matched.route.handler(ctx);
  sendRestResponse(res, response, requestId);
}

// ---------------------------------------------------------------------------------------------
// GraphQL routing
// ---------------------------------------------------------------------------------------------

async function handleGraphqlRoute(
  forge: Forge,
  req: IncomingMessage,
  res: ServerResponse,
  requestId: string,
): Promise<void> {
  if (!authorized(req)) {
    sendJson(res, 401, { message: 'Requires authentication' }, requestId);
    return;
  }
  const raw = await readBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8')) as unknown;
  } catch {
    sendJson(res, 400, { message: 'Problems parsing JSON' }, requestId);
    return;
  }
  const run = (doc: Record<string, unknown>): unknown => {
    const query = typeof doc.query === 'string' ? doc.query : '';
    const variables = (doc.variables ?? {}) as Record<string, unknown>;
    const operationName = typeof doc.operationName === 'string' ? doc.operationName : undefined;
    if (query === '') return { data: null, errors: [{ message: 'Must provide query string.' }] };
    return executeGraphQL(forge, query, variables, operationName);
  };
  if (Array.isArray(parsed)) {
    // A JSON array of operation documents in one request: two results, in order.
    sendJson(res, 200, parsed.map((doc) => (doc !== null && typeof doc === 'object' ? run(doc as Record<string, unknown>) : { data: null, errors: [{ message: 'Must provide query string.' }] })), requestId);
    return;
  }
  if (parsed === null || typeof parsed !== 'object') {
    sendJson(res, 400, { message: 'Problems parsing JSON' }, requestId);
    return;
  }
  sendJson(res, 200, run(parsed as Record<string, unknown>), requestId);
}

// ---------------------------------------------------------------------------------------------
// MCP routing
// ---------------------------------------------------------------------------------------------

async function handleMcpRoute(
  forge: Forge,
  req: IncomingMessage,
  res: ServerResponse,
  requestId: string,
): Promise<void> {
  const raw = await readBody(req);
  const text = raw.toString('utf8');
  // A non-JSON body is a parse error (HTTP 400, code -32700) before auth is considered.
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, requestId);
    return;
  }
  void parsed;
  if (!authorized(req)) {
    sendJson(res, 401, { message: 'Requires authentication' }, requestId);
    return;
  }
  const outcome = handleMcp(forge, text);
  if (outcome.status === 202) {
    res.writeHead(202, { 'x-github-request-id': requestId });
    res.end();
    return;
  }
  sendJson(res, outcome.status, outcome.body, requestId);
}
