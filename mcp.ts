// mcp.ts — Model Context Protocol over Streamable HTTP (POST /mcp).
//
// Speaks both the modern revision (2026-07-28: server/discover answers with
// a supportedVersions list) and the legacy handshake (2025-11-25 and
// earlier: initialize + notifications/initialized, optional Mcp-Session-Id).
// Every tool acts on the same store as REST/GraphQL, so an MCP-created
// repo or issue reads back over /api/v3 as the same object. tools/list is
// a module-level constant, so two calls answer the same list byte for byte.

import type { Forge } from './store.ts';
import { issueJsonOf, pullJsonOf, repoJsonOf } from './store.ts';

export interface McpTool {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

const TOOLS: McpTool[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'The repository name.' } },
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
    description: 'List issues in a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request by number, using a squash merge.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

export interface McpOutcome {
  status: number;
  body: unknown;
}

function rpcResult(id: string | number | null | undefined, result: unknown): McpOutcome {
  return { status: 200, body: { jsonrpc: '2.0', id: id ?? null, result } };
}
function rpcError(id: string | number | null | undefined, code: number, message: string, status = 200): McpOutcome {
  return { status, body: { jsonrpc: '2.0', id: id ?? null, error: { code, message } } };
}
function toolText(value: unknown): { content: Array<{ type: string; text: string }> } {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}
function toolError(message: string): { content: Array<{ type: string; text: string }>; isError: true } {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** Look up an argument by its canonical name, then by common aliases. */
function arg(args: Record<string, unknown>, name: string, aliases: string[] = []): unknown {
  if (args[name] !== undefined) return args[name];
  for (const alias of aliases) {
    if (args[alias] !== undefined) return args[alias];
  }
  return undefined;
}

function findTool(name: string): McpTool | undefined {
  const wanted = name.toLowerCase();
  return TOOLS.find((tool) => {
    const candidate = tool.name.toLowerCase();
    return candidate === wanted || candidate.endsWith(`_${wanted}`) || wanted.endsWith(`_${candidate}`);
  });
}

function callTool(forge: Forge, name: string, args: Record<string, unknown>): { content: Array<{ type: string; text: string }>; isError?: true } {
  const tool = findTool(name);
  if (!tool) return toolError(`unknown tool: ${name}`);
  const owner = String(arg(args, 'owner', ['login', 'user']) ?? '');
  const repoName = String(arg(args, 'repo', ['repository', 'repo_name']) ?? '');
  const repo = owner !== '' && repoName !== '' ? forge.getRepo(owner, repoName) : undefined;
  switch (tool.name) {
    case 'create_repo': {
      const repoNameArg = String(arg(args, 'name') ?? '');
      if (repoNameArg === '') return toolError('missing required argument: name');
      const created = forge.createRepo(repoNameArg, false, '');
      if (!created) return toolError(`repository ${forge.viewer.login}/${repoNameArg} already exists`);
      return toolText(repoJsonOf(created));
    }
    case 'get_repo': {
      if (!repo) return toolError(`repository ${owner}/${repoName} not found`);
      return toolText(repoJsonOf(repo));
    }
    case 'create_issue': {
      if (!repo) return toolError(`repository ${owner}/${repoName} not found`);
      const title = String(arg(args, 'title') ?? '');
      if (title === '') return toolError('missing required argument: title');
      const body = typeof arg(args, 'body') === 'string' ? (arg(args, 'body') as string) : '';
      const result = forge.createIssue(repo, title, body, []);
      if ('error' in result) return toolError(result.error);
      return toolText(issueJsonOf(repo, result));
    }
    case 'list_issues': {
      if (!repo) return toolError(`repository ${owner}/${repoName} not found`);
      const state = typeof arg(args, 'state') === 'string' ? (arg(args, 'state') as string) : 'open';
      const issues = forge.listIssues(repo, { state, sort: 'created', direction: 'desc', perPage: 1000, page: 1 });
      return toolText(issues.map((issue) => issueJsonOf(repo, issue)));
    }
    case 'create_pull_request': {
      if (!repo) return toolError(`repository ${owner}/${repoName} not found`);
      const title = String(arg(args, 'title') ?? '');
      const head = String(arg(args, 'head', ['head_ref', 'head_branch']) ?? '');
      const base = String(arg(args, 'base', ['base_ref', 'base_branch']) ?? repo.defaultBranch);
      if (title === '' || head === '') return toolError('missing required argument: title or head');
      const result = forge.createPull(repo, title, '', head, base);
      if ('error' in result) return toolError(result.error);
      return toolText(pullJsonOf(repo, result));
    }
    case 'merge_pull_request': {
      if (!repo) return toolError(`repository ${owner}/${repoName} not found`);
      const raw = arg(args, 'pull_number', ['number', 'pullNumber', 'pull_request_number']);
      const number = typeof raw === 'number' ? raw : Number(raw);
      if (!Number.isFinite(number)) return toolError('missing required argument: pull_number');
      const pull = forge.getPull(repo, number);
      if (!pull) return toolError(`pull request #${number} not found`);
      const result = forge.mergePull(repo, pull, 'squash');
      if ('error' in result) return toolError(result.error);
      return toolText({ sha: result.sha, merged: true, message: result.message });
    }
    default:
      return toolError(`unknown tool: ${name}`);
  }
}

/**
 * Handle one POST /mcp request. `rawBody` is the request body as text;
 * a non-JSON body is a parse error (HTTP 400, code -32700).
 */
export function handleMcp(forge: Forge, rawBody: string): McpOutcome {
  let request: JsonRpcRequest;
  try {
    request = JSON.parse(rawBody) as JsonRpcRequest;
  } catch {
    return rpcError(null, -32700, 'Parse error', 400);
  }
  if (request === null || typeof request !== 'object' || Array.isArray(request)) {
    return rpcError(null, -32600, 'Invalid Request', 400);
  }
  const id = request.id ?? null;
  const method = request.method ?? '';
  const params = (request.params ?? {}) as Record<string, unknown>;

  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const protocolVersion = SUPPORTED_VERSIONS.includes(requested) ? requested : '2026-07-28';
    return rpcResult(id, {
      protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: 'github-forge', version: '1.0.0' },
    });
  }
  if (method === 'notifications/initialized') {
    // A notification: no reply. If it carries an id, answer with an empty result.
    if (request.id === undefined) return { status: 202, body: null };
    return rpcResult(id, {});
  }
  if (method === 'server/discover') {
    return rpcResult(id, {
      protocolVersion: '2026-07-28',
      supportedVersions: SUPPORTED_VERSIONS,
      capabilities: { tools: {} },
      serverInfo: { name: 'github-forge', version: '1.0.0' },
    });
  }
  if (method === 'ping') {
    return rpcResult(id, {});
  }
  if (method === 'tools/list') {
    return rpcResult(id, { tools: TOOLS });
  }
  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    if (name === '') return rpcError(id, -32602, 'missing required argument: name');
    const tool = findTool(name);
    if (!tool) return rpcError(id, -32602, `unknown tool: ${name}`);
    const outcome = callTool(forge, name, args);
    if (outcome.isError) return rpcResult(id, outcome);
    return rpcResult(id, outcome);
  }
  return rpcError(id, -32601, `method not found: ${method}`);
}
