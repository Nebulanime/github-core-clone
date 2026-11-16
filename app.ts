// The forge's HTTP surface: one Node server that routes every request to the
// git, REST, GraphQL or MCP layer over one shared in-memory store. main.ts owns
// the entry <-> env lifecycle and imports createApp() from here.
//
// Auth: every route except GET /healthz and GET /api/v3[/] needs
// `Authorization: Bearer <MAKEFUN_SHOP_TOKEN>`; without it the answer is a
// JSON 401. Every reply is JSON (or a git binary body) with a request id.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Forge } from './store.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './git.ts';
import { handleRest, type RestRequest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { pathSegments, readBody, sendError, sendJson, sendNoContent } from './http.ts';

function isAuthed(forge: Forge, req: IncomingMessage): boolean {
  if (forge.token === '') return false;
  return req.headers.authorization === `Bearer ${forge.token}`;
}

async function handle(forge: Forge, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET';
  let pathname = '/';
  let query = new URLSearchParams();
  try {
    const url = new URL(req.url ?? '/', 'http://entry');
    pathname = url.pathname;
    query = url.searchParams;
  } catch {
    pathname = '/';
  }
  const segments = pathSegments(pathname);

  // The env's boot probe: 200 {"ok":true}, no auth.
  if (method === 'GET' && pathname === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  // The API root: no auth, like api.github.com.
  if (pathname === '/api/v3' || pathname === '/api/v3/') {
    const r: RestRequest = { method, segments: [], query, host: req.headers.host ?? '127.0.0.1', body: Buffer.alloc(0) };
    handleRest(forge, req, res, r);
    return;
  }

  if (!isAuthed(forge, req)) {
    sendError(res, 401, 'Bad credentials');
    return;
  }

  const needsBody = method !== 'GET' && method !== 'HEAD';
  const body = needsBody ? await readBody(req) : Buffer.alloc(0);

  // REST v3 under /api/v3.
  if (segments[0] === 'api' && segments[1] === 'v3') {
    const r: RestRequest = {
      method,
      segments: segments.slice(2),
      query,
      host: req.headers.host ?? '127.0.0.1',
      body,
    };
    handleRest(forge, req, res, r);
    return;
  }

  // GraphQL v4.
  if (segments[0] === 'api' && segments[1] === 'graphql' && segments.length === 2) {
    if (method !== 'POST') {
      sendError(res, 404, 'Not Found');
      return;
    }
    handleGraphQL(forge, req, res, body);
    return;
  }

  // MCP.
  if (segments[0] === 'mcp' && segments.length === 1) {
    if (method === 'DELETE') {
      sendNoContent(res);
      return;
    }
    if (method !== 'POST') {
      sendError(res, 404, 'Not Found');
      return;
    }
    handleMcp(forge, req, res, body);
    return;
  }

  // git smart HTTP: /{owner}/{repo}.git/...
  if (segments.length >= 2 && (segments[1] as string).endsWith('.git')) {
    const owner = segments[0] as string;
    const repoName = (segments[1] as string).slice(0, -4);
    const tail = segments.slice(2);
    if (method === 'GET' && tail[0] === 'info' && tail[1] === 'refs') {
      handleInfoRefs(forge, req, res, owner, repoName);
      return;
    }
    if (method === 'POST' && tail[0] === 'git-upload-pack') {
      handleUploadPack(forge, res, owner, repoName, body);
      return;
    }
    if (method === 'POST' && tail[0] === 'git-receive-pack') {
      handleReceivePack(forge, res, owner, repoName, body);
      return;
    }
  }

  sendError(res, 404, 'Not Found');
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const forge = new Forge(process.env.MAKEFUN_SHOP_TOKEN ?? '');
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void handle(forge, req, res).catch((err: unknown) => {
      // A request must never take the server down with it.
      try {
        if (!res.headersSent) sendError(res, 500, err instanceof Error ? err.message : 'internal error');
        else res.destroy();
      } catch {
        res.destroy();
      }
    });
  });
}
