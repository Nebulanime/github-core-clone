// MCP at /mcp: JSON-RPC 2.0 over Streamable HTTP. The modern era is served
// (server/discover, revision 2026-07-28) with the legacy initialize handshake
// as a fallback. Tools share the forge store with REST: a repo or issue an MCP
// tool creates is the same object over REST, with stable ids.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { Forge } from './store.ts';
import { issueJson, pullJson, repoJson } from './rest.ts';
import { nextRequestId, parseJsonBody, sendJson } from './http.ts';

const SERVER_NAME = 'makefun-forge';
const SERVER_VERSION = '1.0.0';
const MODERN_REVISION = '2026-07-28';
const LEGACY_REVISIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string; items?: { type: string } }>;
    required: string[];
  };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository for the authenticated user.',
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
    description: 'Read one repository by owner and name.',
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
        labels: { type: 'array', description: 'Label names to attach.', items: { type: 'string' } },
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
    description: 'Create a pull request from a head branch onto a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request.',
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
];

const TOOL_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

interface ToolOutcome {
  ok: boolean;
  value?: Record<string, unknown>;
  error?: string;
}

function callTool(forge: Forge, name: string, args: Record<string, unknown>): ToolOutcome {
  const tool = TOOL_BY_NAME.get(name);
  if (tool === undefined) return { ok: false, error: `unknown tool ${name}` };
  for (const required of tool.inputSchema.required) {
    if (args[required] === undefined || args[required] === null || args[required] === '') {
      return { ok: false, error: `missing required argument ${required}` };
    }
  }
  const owner = asString(args.owner) ?? forge.viewerLogin;
  const repoName = asString(args.repo) ?? asString(args.repository) ?? asString(args.repo_name) ?? '';

  if (name === 'create_repo') {
    const repoNameArg = asString(args.name);
    if (repoNameArg === undefined || repoNameArg === '') return { ok: false, error: 'missing required argument name' };
    const created = forge.createRepo(forge.viewerLogin, repoNameArg, {
      description: asString(args.description) ?? null,
      isPrivate: typeof args.private === 'boolean' ? args.private : true,
    });
    if (created === null) return { ok: false, error: 'name already exists on this account' };
    return { ok: true, value: repoJson(forge, created) as Record<string, unknown> };
  }

  const repo = repoName === '' ? undefined : forge.getRepo(owner, repoName);
  if (repo === undefined) return { ok: false, error: `repository ${owner}/${repoName} was not found` };

  if (name === 'get_repo') {
    return { ok: true, value: repoJson(forge, repo) as Record<string, unknown> };
  }
  if (name === 'create_issue') {
    const title = asString(args.title) ?? '';
    const body = asString(args.body) ?? '';
    const labels = Array.isArray(args.labels) ? (args.labels.filter((item) => typeof item === 'string') as string[]) : [];
    const created = forge.createIssue(repo, title, body, labels);
    if ('error' in created) return { ok: false, error: created.error };
    return { ok: true, value: issueJson(repo, created) as Record<string, unknown> };
  }
  if (name === 'list_issues') {
    const state = asString(args.state) ?? 'open';
    let issues = [...repo.issues];
    if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
    issues.sort((a, b) => b.number - a.number);
    const value = { issues: issues.map((issue) => issueJson(repo, issue)) };
    return { ok: true, value: value as unknown as Record<string, unknown> };
  }
  if (name === 'create_pull_request') {
    const created = forge.createPull(
      repo,
      asString(args.title) ?? '',
      asString(args.body) ?? '',
      asString(args.head) ?? '',
      asString(args.base) ?? '',
    );
    if ('error' in created) return { ok: false, error: created.error };
    return { ok: true, value: pullJson(repo, created) as Record<string, unknown> };
  }
  if (name === 'merge_pull_request') {
    const number = asNumber(args.pull_number);
    if (number === undefined) return { ok: false, error: 'pull_number must be a number' };
    const pull = forge.findPull(repo, number);
    if (pull === undefined) return { ok: false, error: `pull request #${number} was not found` };
    const result = forge.mergePull(repo, pull);
    if (result.status !== 200) return { ok: false, error: result.message };
    return { ok: true, value: { sha: result.sha, merged: true, message: `Pull Request #${number} merged` } };
  }
  return { ok: false, error: `unknown tool ${name}` };
}

// ---------------------------------------------------------------------------
// JSON-RPC framing.
// ---------------------------------------------------------------------------

function rpcResult(res: ServerResponse, id: unknown, result: unknown): void {
  sendJson(res, 200, { jsonrpc: '2.0', id: id ?? null, result });
}

function rpcError(res: ServerResponse, id: unknown, code: number, message: string, status = 200): void {
  sendJson(res, status, { jsonrpc: '2.0', id: id ?? null, error: { code, message } });
}

export function handleMcp(forge: Forge, req: IncomingMessage, res: ServerResponse, body: Buffer): void {
  const parsed = parseJsonBody(body);
  if (!parsed.ok) {
    // A body that is not JSON is a JSON-RPC parse error: HTTP 400, -32700.
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  const value = parsed.value;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
    return;
  }
  const request = value as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
  const id = request.id ?? null;
  const method = typeof request.method === 'string' ? request.method : '';
  const params =
    typeof request.params === 'object' && request.params !== null ? (request.params as Record<string, unknown>) : {};

  // Notifications carry no id and expect no result.
  if (id === null && method.startsWith('notifications/')) {
    res.writeHead(202, { 'x-github-request-id': nextRequestId() });
    res.end();
    return;
  }

  if (method === 'server/discover') {
    rpcResult(res, id, {
      supportedVersions: [MODERN_REVISION, ...LEGACY_REVISIONS],
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
    });
    return;
  }

  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const protocolVersion = LEGACY_REVISIONS.includes(requested) || requested === MODERN_REVISION ? requested : '2025-11-25';
    rpcResult(res, id, {
      protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
    return;
  }

  if (method === 'ping') {
    rpcResult(res, id, {});
    return;
  }

  if (method === 'tools/list') {
    rpcResult(res, id, { tools: TOOLS });
    return;
  }

  if (method === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args =
      typeof params.arguments === 'object' && params.arguments !== null
        ? (params.arguments as Record<string, unknown>)
        : {};
    if (toolName === '') {
      rpcError(res, id, -32602, 'tools/call needs a tool name');
      return;
    }
    if (!TOOL_BY_NAME.has(toolName)) {
      rpcError(res, id, -32601, `unknown tool ${toolName}`);
      return;
    }
    const outcome = callTool(forge, toolName, args);
    if (!outcome.ok) {
      rpcResult(res, id, {
        content: [{ type: 'text', text: outcome.error ?? 'the tool call failed' }],
        isError: true,
      });
      return;
    }
    const text = JSON.stringify(outcome.value ?? {});
    rpcResult(res, id, {
      content: [{ type: 'text', text }],
      structuredContent: outcome.value ?? {},
    });
    return;
  }

  rpcError(res, id, -32601, `method not found: ${method}`);
}
