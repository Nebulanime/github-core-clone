// REST v3 under /api/v3: repositories, branches, commits, git refs, contents,
// labels, issues (+comments) and pull requests (+files, merge). Every reply is
// JSON with a non-empty X-GitHub-Request-Id; errors carry a string `message`.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  Forge,
  VIEWER_USER,
  commentGlobalId,
  globalId,
  issueGlobalId,
  parseCommit,
  pullGlobalId,
  repoGlobalId,
  trialNowSec,
  type Issue,
  type Label,
  type Pull,
  type Repo,
} from './store.ts';
import { parseJsonBody, sendError, sendJson, sendNoContent } from './http.ts';

export interface RestRequest {
  method: string;
  segments: string[];
  query: URLSearchParams;
  host: string;
  body: Buffer;
}

const isoNow = (): string => new Date(trialNowSec() * 1000).toISOString();

// ---------------------------------------------------------------------------
// JSON shapes.
// ---------------------------------------------------------------------------

export function repoJson(forge: Forge, repo: Repo): Record<string, unknown> {
  const now = isoNow();
  return {
    id: repoGlobalId(repo.owner, repo.name),
    node_id: repoGlobalId(repo.owner, repo.name),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER_USER.id, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    fork: false,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
    html_url: `/repos/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    clone_url: `/${repo.owner}/${repo.name}.git`,
    created_at: now,
    updated_at: now,
    pushed_at: now,
    language: null,
    visibility: repo.isPrivate ? 'private' : 'public',
  };
}

function labelJson(label: Label): Record<string, unknown> {
  return {
    id: globalId('L', label.name),
    node_id: globalId('L', label.name),
    name: label.name,
    color: label.color,
    description: label.description,
    url: `/api/v3/labels/${encodeURIComponent(label.name)}`,
  };
}

export function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  const now = isoNow();
  return {
    id: issueGlobalId(repo.owner, repo.name, issue.number),
    node_id: issueGlobalId(repo.owner, repo.name, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return label !== undefined ? labelJson(label) : { name };
    }),
    user: { login: VIEWER_USER.login, id: VIEWER_USER.id, type: 'User' },
    comments: issue.comments.length,
    created_at: now,
    updated_at: now,
    html_url: `/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

export function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  const now = isoNow();
  return {
    id: pullGlobalId(repo.owner, repo.name, pull.number),
    node_id: pullGlobalId(repo.owner, repo.name, pull.number),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}` },
    user: { login: VIEWER_USER.login, id: VIEWER_USER.id, type: 'User' },
    created_at: now,
    updated_at: now,
    html_url: `/repos/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

function jsonBody(req: RestRequest): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  const parsed = parseJsonBody(req.body);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const value = parsed.value;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, error: 'the body must be a JSON object' };
  }
  return { ok: true, value: value as Record<string, unknown> };
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === 'string') out.push(item);
    else if (typeof item === 'object' && item !== null && typeof (item as { name?: unknown }).name === 'string') {
      out.push((item as { name: string }).name);
    } else return undefined;
  }
  return out;
}

function pageParams(query: URLSearchParams): { perPage: number; page: number } {
  const perPageRaw = Number(query.get('per_page') ?? '30');
  const pageRaw = Number(query.get('page') ?? '1');
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(100, Math.floor(perPageRaw)) : 30;
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.floor(pageRaw) : 1;
  return { perPage, page };
}

function paginate<T>(items: readonly T[], query: URLSearchParams): { page: T[]; hasNext: boolean; totalPages: number } {
  const { perPage, page } = pageParams(query);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (page - 1) * perPage;
  return { page: items.slice(start, start + perPage), hasNext: page < totalPages, totalPages };
}

function linkHeader(req: RestRequest, query: URLSearchParams, hasNext: boolean, totalPages: number): Record<string, string> {
  const { perPage, page } = pageParams(query);
  if (!hasNext && totalPages <= 1) return {};
  const base = `http://${req.host}/api/v3/user/repos?per_page=${perPage}`;
  const links: string[] = [];
  if (hasNext) links.push(`<${base}&page=${page + 1}>; rel="next"`);
  links.push(`<${base}&page=${totalPages}>; rel="last"`);
  return { link: links.join(', ') };
}

/** Resolve a repo from the URL owner/name, learning the viewer when it exists. */
function resolveRepo(forge: Forge, owner: string, name: string): Repo | undefined {
  const repo = forge.getRepo(owner, name);
  return repo;
}

// ---------------------------------------------------------------------------
// The router.
// ---------------------------------------------------------------------------

export function handleRest(forge: Forge, req: IncomingMessage, res: ServerResponse, r: RestRequest): void {
  try {
    routeRest(forge, req, res, r);
  } catch (err) {
    sendError(res, 500, err instanceof Error ? err.message : 'internal error');
  }
}

function routeRest(forge: Forge, _req: IncomingMessage, res: ServerResponse, r: RestRequest): void {
  const seg = r.segments;
  const method = r.method;

  // GET /api/v3/ — the API root (no auth needed, like api.github.com).
  if (seg.length === 0) {
    if (method !== 'GET') {
      sendError(res, 404, 'Not Found');
      return;
    }
    sendJson(
      res,
      200,
      { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' },
      { 'x-oauth-scopes': 'repo, read:org' },
    );
    return;
  }

  // GET /api/v3/meta
  if (seg.length === 1 && seg[0] === 'meta') {
    if (method !== 'GET') {
      sendError(res, 404, 'Not Found');
      return;
    }
    sendJson(res, 200, { installed_version: '1.0.0' });
    return;
  }

  // GET /api/v3/user
  if (seg.length === 1 && seg[0] === 'user') {
    if (method !== 'GET') {
      sendError(res, 404, 'Not Found');
      return;
    }
    sendJson(res, 200, {
      login: forge.viewerLogin,
      id: VIEWER_USER.id,
      node_id: globalId('U', forge.viewerLogin),
      name: VIEWER_USER.name,
      email: VIEWER_USER.email,
      type: 'User',
    });
    return;
  }

  // POST/GET /api/v3/user/repos
  if (seg.length === 2 && seg[0] === 'user' && seg[1] === 'repos') {
    if (method === 'POST') {
      const parsed = jsonBody(r);
      if (!parsed.ok) {
        sendError(res, 400, parsed.error);
        return;
      }
      const name = asString(parsed.value.name);
      if (name === undefined || name === '') {
        sendError(res, 422, 'name is required');
        return;
      }
      const created = forge.createRepo(forge.viewerLogin, name, {
        description: asString(parsed.value.description) ?? null,
        isPrivate: asBoolean(parsed.value.private) ?? true,
      });
      if (created === null) {
        sendError(res, 422, 'name already exists on this account');
        return;
      }
      sendJson(res, 201, repoJson(forge, created));
      return;
    }
    if (method === 'GET') {
      const repos = forge.viewerRepos();
      const { page, hasNext, totalPages } = paginate(repos, r.query);
      sendJson(
        res,
        200,
        page.map((repo) => repoJson(forge, repo)),
        linkHeader(r, r.query, hasNext, totalPages),
      );
      return;
    }
    sendError(res, 404, 'Not Found');
    return;
  }

  // /api/v3/repos/{owner}/{repo}[...]
  if (seg.length >= 3 && seg[0] === 'repos') {
    const owner = seg[1] as string;
    const name = seg[2] as string;
    const repo = resolveRepo(forge, owner, name);
    if (repo === undefined) {
      sendError(res, 404, 'Not Found');
      return;
    }
    routeRepo(forge, res, r, repo);
    return;
  }

  sendError(res, 404, 'Not Found');
}

function routeRepo(forge: Forge, res: ServerResponse, r: RestRequest, repo: Repo): void {
  const seg = r.segments;
  const method = r.method;
  const rest = seg.slice(3);

  // GET/PATCH/DELETE /api/v3/repos/{o}/{r}
  if (rest.length === 0) {
    if (method === 'GET') {
      sendJson(res, 200, repoJson(forge, repo));
      return;
    }
    if (method === 'PATCH') {
      const parsed = jsonBody(r);
      if (!parsed.ok) {
        sendError(res, 400, parsed.error);
        return;
      }
      const description = asString(parsed.value.description);
      if (description !== undefined) repo.description = description;
      const isPrivate = asBoolean(parsed.value.private);
      if (isPrivate !== undefined) repo.isPrivate = isPrivate;
      sendJson(res, 200, repoJson(forge, repo));
      return;
    }
    if (method === 'DELETE') {
      forge.deleteRepo(repo.owner, repo.name);
      sendNoContent(res);
      return;
    }
    sendError(res, 404, 'Not Found');
    return;
  }

  const head = rest[0] as string;

  // GET /branches and GET /branches/{branch}
  if (head === 'branches') {
    if (method !== 'GET') {
      sendError(res, 404, 'Not Found');
      return;
    }
    if (rest.length === 1) {
      const branches = forge.branches(repo).map((branch) => ({
        name: branch.name,
        commit: { sha: branch.oid },
        protected: false,
      }));
      sendJson(res, 200, branches);
      return;
    }
    const branchName = rest.slice(1).join('/');
    const tip = repo.refs.get(`refs/heads/${branchName}`);
    if (tip === undefined) {
      sendError(res, 404, 'Not Found');
      return;
    }
    sendJson(res, 200, { name: branchName, commit: { sha: tip }, protected: false });
    return;
  }

  // GET /commits[?sha=]
  if (head === 'commits') {
    if (method !== 'GET') {
      sendError(res, 404, 'Not Found');
      return;
    }
    const ref = r.query.get('sha') ?? undefined;
    const tip = forge.resolveRef(repo, ref);
    if (tip === undefined) {
      sendJson(res, 200, []);
      return;
    }
    const history = forge.commitHistory(repo, tip);
    const { page } = paginate(history, r.query);
    const commits = page.map((oid) => {
      const object = repo.objects.get(oid);
      const parsed = object !== undefined && object.type === 'commit' ? parseCommit(object.data) : { message: '' };
      return {
        sha: oid,
        commit: {
          message: parsed.message,
          author: { name: VIEWER_USER.name, email: VIEWER_USER.email, date: isoNow() },
          committer: { name: VIEWER_USER.name, email: VIEWER_USER.email, date: isoNow() },
        },
        author: { login: VIEWER_USER.login, id: VIEWER_USER.id, type: 'User' },
        committer: { login: VIEWER_USER.login, id: VIEWER_USER.id, type: 'User' },
        parents: [],
        url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${oid}`,
      };
    });
    sendJson(res, 200, commits);
    return;
  }

  // POST /git/refs and GET /git/refs/...
  if (head === 'git' && rest[1] === 'refs') {
    if (method === 'POST' && rest.length === 2) {
      const parsed = jsonBody(r);
      if (!parsed.ok) {
        sendError(res, 400, parsed.error);
        return;
      }
      const ref = asString(parsed.value.ref);
      const sha = asString(parsed.value.sha);
      if (ref === undefined || sha === undefined) {
        sendError(res, 422, 'ref and sha are required');
        return;
      }
      if (!ref.startsWith('refs/')) {
        sendError(res, 422, 'ref must start with refs/');
        return;
      }
      if (repo.refs.has(ref)) {
        sendError(res, 422, 'Reference already exists');
        return;
      }
      const object = repo.objects.get(sha);
      if (object === undefined || (object.type !== 'commit' && object.type !== 'tag')) {
        sendError(res, 422, 'the sha does not name a commit');
        return;
      }
      repo.refs.set(ref, sha);
      sendJson(res, 201, {
        ref,
        node_id: globalId('REF', `${repo.owner}/${repo.name}/${ref}`),
        url: `/api/v3/repos/${repo.owner}/${repo.name}/git/refs/${ref.replace(/^refs\//, '')}`,
        object: { sha, type: object.type, url: '' },
      });
      return;
    }
    if (method === 'GET' && rest.length > 2) {
      const refName = `refs/${rest.slice(2).join('/')}`;
      const tip = repo.refs.get(refName);
      if (tip === undefined) {
        sendError(res, 404, 'Not Found');
        return;
      }
      const object = repo.objects.get(tip);
      sendJson(res, 200, {
        ref: refName,
        node_id: globalId('REF', `${repo.owner}/${repo.name}/${refName}`),
        url: `/api/v3/repos/${repo.owner}/${repo.name}/git/refs/${refName.replace(/^refs\//, '')}`,
        object: { sha: tip, type: object?.type ?? 'commit', url: '' },
      });
      return;
    }
    sendError(res, 404, 'Not Found');
    return;
  }

  // PUT/GET/DELETE /contents/{path}
  if (head === 'contents') {
    const filePath = rest.slice(1).join('/');
    if (filePath === '') {
      sendError(res, 404, 'Not Found');
      return;
    }
    if (method === 'PUT') {
      const parsed = jsonBody(r);
      if (!parsed.ok) {
        sendError(res, 400, parsed.error);
        return;
      }
      const message = asString(parsed.value.message) ?? '';
      const contentB64 = asString(parsed.value.content);
      if (contentB64 === undefined) {
        sendError(res, 422, 'content is required');
        return;
      }
      let content: Buffer;
      try {
        content = Buffer.from(contentB64.replace(/[\r\n\t ]+/g, ''), 'base64');
      } catch {
        sendError(res, 422, 'content is not valid base64');
        return;
      }
      const branch = asString(parsed.value.branch);
      const sha = asString(parsed.value.sha);
      const result = forge.putContent(repo, filePath, content, message, branch, sha);
      if ('message' in result) {
        sendError(res, result.status, result.message);
        return;
      }
      sendJson(res, result.status, {
        content: {
          name: filePath.split('/').pop(),
          path: filePath,
          sha: result.contentSha,
          size: content.length,
          encoding: 'base64',
          type: 'file',
        },
        commit: { sha: result.commitSha },
      });
      return;
    }
    if (method === 'GET') {
      const ref = r.query.get('ref') ?? undefined;
      const tip = forge.resolveRef(repo, ref);
      if (tip === undefined) {
        sendError(res, 404, 'Not Found');
        return;
      }
      const file = forge.fileAt(repo, tip, filePath);
      if (file !== null) {
        const object = repo.objects.get(file.oid);
        const data = object?.data ?? Buffer.alloc(0);
        sendJson(res, 200, {
          type: 'file',
          encoding: 'base64',
          size: data.length,
          name: filePath.split('/').pop(),
          path: filePath,
          content: data.toString('base64'),
          sha: file.oid,
          url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${filePath}`,
          html_url: '',
          download_url: '',
        });
        return;
      }
      const dir = forge.dirAt(repo, tip, filePath);
      if (dir !== null) {
        sendJson(
          res,
          200,
          dir.map((entry) => ({
            type: entry.mode === '40000' ? 'dir' : 'file',
            size: entry.mode === '40000' ? 0 : (repo.objects.get(entry.oid)?.data.length ?? 0),
            name: entry.name,
            path: entry.path,
            sha: entry.oid,
            url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${entry.path}`,
            html_url: '',
            download_url: entry.mode === '40000' ? null : '',
          })),
        );
        return;
      }
      sendError(res, 404, 'Not Found');
      return;
    }
    if (method === 'DELETE') {
      const parsed = jsonBody(r);
      if (!parsed.ok) {
        sendError(res, 400, parsed.error);
        return;
      }
      const message = asString(parsed.value.message) ?? '';
      const sha = asString(parsed.value.sha);
      const branch = asString(parsed.value.branch);
      const result = forge.deleteContent(repo, filePath, message, sha, branch);
      if ('message' in result) {
        sendError(res, result.status, result.message);
        return;
      }
      sendJson(res, 200, { commit: { sha: result.commitSha } });
      return;
    }
    sendError(res, 404, 'Not Found');
    return;
  }

  // POST/GET /labels
  if (head === 'labels') {
    if (method === 'POST' && rest.length === 1) {
      const parsed = jsonBody(r);
      if (!parsed.ok) {
        sendError(res, 400, parsed.error);
        return;
      }
      const name = asString(parsed.value.name);
      if (name === undefined || name === '') {
        sendError(res, 422, 'name is required');
        return;
      }
      if (repo.labels.has(name)) {
        sendError(res, 422, 'Label already exists');
        return;
      }
      const label: Label = {
        name,
        color: asString(parsed.value.color) ?? 'ededed',
        description: asString(parsed.value.description) ?? '',
      };
      repo.labels.set(name, label);
      sendJson(res, 201, labelJson(label));
      return;
    }
    if (method === 'GET' && rest.length === 1) {
      sendJson(res, 200, [...repo.labels.values()].map(labelJson));
      return;
    }
    sendError(res, 404, 'Not Found');
    return;
  }

  // POST/GET /issues, GET/PATCH /issues/{n}, comments
  if (head === 'issues') {
    if (rest.length === 1) {
      if (method === 'POST') {
        const parsed = jsonBody(r);
        if (!parsed.ok) {
          sendError(res, 400, parsed.error);
          return;
        }
        const title = asString(parsed.value.title);
        if (title === undefined || title === '') {
          sendError(res, 422, 'title is required');
          return;
        }
        const body = asString(parsed.value.body) ?? '';
        const labels = asStringArray(parsed.value.labels) ?? [];
        const created = forge.createIssue(repo, title, body, labels);
        if ('error' in created) {
          sendError(res, 422, created.error);
          return;
        }
        sendJson(res, 201, issueJson(repo, created));
        return;
      }
      if (method === 'GET') {
        const state = r.query.get('state') ?? 'open';
        const sort = r.query.get('sort') ?? 'created';
        const direction = r.query.get('direction') ?? 'desc';
        let issues = [...repo.issues];
        if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
        if (sort === 'created') {
          issues.sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
        }
        const { page } = paginate(issues, r.query);
        sendJson(res, 200, page.map((issue) => issueJson(repo, issue)));
        return;
      }
      sendError(res, 404, 'Not Found');
      return;
    }
    const number = Number(rest[1]);
    if (!Number.isInteger(number) || number < 1) {
      sendError(res, 404, 'Not Found');
      return;
    }
    const issue = forge.findIssue(repo, number);
    if (rest.length === 2) {
      if (issue === undefined) {
        sendError(res, 404, 'Not Found');
        return;
      }
      if (method === 'GET') {
        sendJson(res, 200, issueJson(repo, issue));
        return;
      }
      if (method === 'PATCH') {
        const parsed = jsonBody(r);
        if (!parsed.ok) {
          sendError(res, 400, parsed.error);
          return;
        }
        const state = asString(parsed.value.state);
        if (state === 'open' || state === 'closed') issue.state = state;
        const title = asString(parsed.value.title);
        if (title !== undefined) issue.title = title;
        const body = asString(parsed.value.body);
        if (body !== undefined) issue.body = body;
        sendJson(res, 200, issueJson(repo, issue));
        return;
      }
      sendError(res, 404, 'Not Found');
      return;
    }
    if (rest.length === 3 && rest[2] === 'comments') {
      if (issue === undefined) {
        sendError(res, 404, 'Not Found');
        return;
      }
      if (method === 'POST') {
        const parsed = jsonBody(r);
        if (!parsed.ok) {
          sendError(res, 400, parsed.error);
          return;
        }
        const body = asString(parsed.value.body);
        if (body === undefined) {
          sendError(res, 422, 'body is required');
          return;
        }
        const comment = { id: repo.nextCommentId, body };
        repo.nextCommentId += 1;
        issue.comments.push(comment);
        sendJson(res, 201, {
          id: comment.id,
          node_id: commentGlobalId(repo.owner, repo.name, issue.number, comment.id),
          body: comment.body,
          user: { login: VIEWER_USER.login, id: VIEWER_USER.id, type: 'User' },
          created_at: isoNow(),
          updated_at: isoNow(),
        });
        return;
      }
      if (method === 'GET') {
        sendJson(
          res,
          200,
          issue.comments.map((comment) => ({
            id: comment.id,
            node_id: commentGlobalId(repo.owner, repo.name, issue.number, comment.id),
            body: comment.body,
            user: { login: VIEWER_USER.login, id: VIEWER_USER.id, type: 'User' },
            created_at: isoNow(),
            updated_at: isoNow(),
          })),
        );
        return;
      }
      sendError(res, 404, 'Not Found');
      return;
    }
    sendError(res, 404, 'Not Found');
    return;
  }

  // POST/GET /pulls, GET /pulls/{n}, GET /pulls/{n}/files, PUT /pulls/{n}/merge
  if (head === 'pulls') {
    if (rest.length === 1) {
      if (method === 'POST') {
        const parsed = jsonBody(r);
        if (!parsed.ok) {
          sendError(res, 400, parsed.error);
          return;
        }
        const title = asString(parsed.value.title);
        const headRef = asString(parsed.value.head);
        const baseRef = asString(parsed.value.base);
        if (title === undefined || headRef === undefined || baseRef === undefined) {
          sendError(res, 422, 'title, head and base are required');
          return;
        }
        const body = asString(parsed.value.body) ?? '';
        const created = forge.createPull(repo, title, body, headRef, baseRef);
        if ('error' in created) {
          sendError(res, 422, created.error);
          return;
        }
        sendJson(res, 201, pullJson(repo, created));
        return;
      }
      if (method === 'GET') {
        const state = r.query.get('state') ?? 'open';
        let pulls = [...repo.pulls];
        if (state !== 'all') pulls = pulls.filter((pull) => pull.state === state);
        pulls.sort((a, b) => b.createdSeq - a.createdSeq);
        const { page } = paginate(pulls, r.query);
        sendJson(res, 200, page.map((pull) => pullJson(repo, pull)));
        return;
      }
      sendError(res, 404, 'Not Found');
      return;
    }
    const number = Number(rest[1]);
    if (!Number.isInteger(number) || number < 1) {
      sendError(res, 404, 'Not Found');
      return;
    }
    const pull = forge.findPull(repo, number);
    if (rest.length === 2) {
      if (pull === undefined) {
        sendError(res, 404, 'Not Found');
        return;
      }
      if (method === 'GET') {
        sendJson(res, 200, pullJson(repo, pull));
        return;
      }
      sendError(res, 404, 'Not Found');
      return;
    }
    if (rest.length === 3 && rest[2] === 'files') {
      if (pull === undefined) {
        sendError(res, 404, 'Not Found');
        return;
      }
      if (method === 'GET') {
        sendJson(res, 200, pull.files);
        return;
      }
      sendError(res, 404, 'Not Found');
      return;
    }
    if (rest.length === 3 && rest[2] === 'merge') {
      if (pull === undefined) {
        sendError(res, 404, 'Not Found');
        return;
      }
      if (method === 'PUT') {
        const result = forge.mergePull(repo, pull);
        if (result.status !== 200) {
          sendError(res, result.status, result.message);
          return;
        }
        sendJson(res, 200, { sha: result.sha, merged: true, message: `Pull Request #${pull.number} merged` });
        return;
      }
      sendError(res, 404, 'Not Found');
      return;
    }
    sendError(res, 404, 'Not Found');
    return;
  }

  sendError(res, 404, 'Not Found');
}
