// rest.ts — the GitHub REST v3 surface (/api/v3).
//
// Every reply is application/json with a non-empty X-GitHub-Request-Id (the
// app layer adds those); an unknown route is a JSON 404, a malformed JSON
// body is a 400, and every error body carries a string `message`. A request
// with no bearer token is 401; the same repository name under another login
// is 404, never 403 (the repo lives under the token owner's login only).

import { isObjectId, parseCommit, parseTree, ZERO_OID } from './gitcore.ts';
import type { Forge, Repo } from './store.ts';
import { issueJsonOf, pullJsonOf, repoJsonOf } from './store.ts';

export interface RestResponse {
  status: number;
  body: unknown; // null = no body (204)
  headers?: Record<string, string>;
}

export function ok(body: unknown, status = 200, headers?: Record<string, string>): RestResponse {
  return { status, body, headers };
}
export function err(status: number, message: string): RestResponse {
  return { status, body: { message } };
}

export interface RestContext {
  forge: Forge;
  /** The request's own origin (scheme://host), for absolute Link URLs. */
  origin: string;
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function bodyOf(ctx: RestContext): Record<string, unknown> {
  return isRecord(ctx.body) ? ctx.body : {};
}

function repoOf(ctx: RestContext): Repo | RestResponse {
  const repo = ctx.forge.getRepo(ctx.params.owner ?? '', ctx.params.repo ?? '');
  if (!repo) return err(404, `repository ${ctx.params.owner}/${ctx.params.repo} not found`);
  return repo;
}

function intQuery(ctx: RestContext, name: string, fallback: number): number {
  const raw = ctx.query.get(name);
  if (raw === null) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function paginate<T>(items: T[], ctx: RestContext): { page: T[]; total: number; perPage: number; pageNo: number } {
  const perPage = intQuery(ctx, 'per_page', 30);
  const pageNo = intQuery(ctx, 'page', 1);
  const start = (pageNo - 1) * perPage;
  return { page: items.slice(start, start + perPage), total: items.length, perPage, pageNo };
}

function linkHeader(origin: string, path: string, query: URLSearchParams, perPage: number, pageNo: number, total: number): string | null {
  const pages = Math.max(1, Math.ceil(total / perPage));
  if (pageNo >= pages) return null;
  const build = (page: number): string => {
    const q = new URLSearchParams(query);
    q.set('per_page', String(perPage));
    q.set('page', String(page));
    return `${origin}${path}?${q.toString()}`;
  };
  const parts = [`<${build(pageNo + 1)}>; rel="next"`, `<${build(pages)}>; rel="last"`, `<${build(1)}>; rel="first"`];
  if (pageNo > 1) parts.push(`<${build(pageNo - 1)}>; rel="prev"`);
  return parts.join(', ');
}

// ---------------------------------------------------------------------------------------------
// root / meta / user
// ---------------------------------------------------------------------------------------------

export function getRoot(_ctx: RestContext): RestResponse {
  return ok(
    {
      current_user_url: '/api/v3/user',
      current_user_authorizations_html_url: 'https://github.com/settings/applications',
      authorizations_url: '/api/v3/authorizations',
      repository_url: '/api/v3/repos/{owner}/{repo}',
      user_url: '/api/v3/users/{user}',
      meta: { installed_version: '1.0.0' },
    },
    200,
    { 'x-oauth-scopes': 'repo, user' },
  );
}

export function getMeta(_ctx: RestContext): RestResponse {
  return ok({ installed_version: '1.0.0' });
}

export function getUser(ctx: RestContext): RestResponse {
  const viewer = ctx.forge.viewer;
  return ok({
    login: viewer.login,
    id: viewer.id,
    node_id: Buffer.from(`user:${viewer.login}`, 'utf8').toString('base64'),
    name: viewer.name,
    email: viewer.email,
    type: 'User',
    html_url: `https://github.com/${viewer.login}`,
    url: '/api/v3/user',
  });
}

// ---------------------------------------------------------------------------------------------
// repositories
// ---------------------------------------------------------------------------------------------

export function createUserRepo(ctx: RestContext): RestResponse {
  const body = bodyOf(ctx);
  const name = typeof body.name === 'string' ? body.name : '';
  if (name === '') return err(422, 'name is required');
  const repo = ctx.forge.createRepo(name, body.private === true, typeof body.description === 'string' ? body.description : '');
  if (!repo) return err(422, `Repository ${ctx.forge.viewer.login}/${name} already exists`);
  return ok(repoJsonOf(repo), 201);
}

export function listUserRepos(ctx: RestContext): RestResponse {
  const all = ctx.forge.listViewerRepos();
  const { page, total, perPage, pageNo } = paginate(all, ctx);
  const headers: Record<string, string> = {};
  const link = linkHeader(ctx.origin, '/api/v3/user/repos', ctx.query, perPage, pageNo, total);
  if (link) headers.link = link;
  return ok(page.map((repo) => repoJsonOf(repo)), 200, headers);
}

export function getRepo(ctx: RestContext): RestResponse {
  const repo = repoOf(ctx);
  if ('status' in repo) return repo;
  return ok(repoJsonOf(repo));
}

export function patchRepo(ctx: RestContext): RestResponse {
  const repo = repoOf(ctx);
  if ('status' in repo) return repo;
  const body = bodyOf(ctx);
  if (typeof body.description === 'string') repo.description = body.description;
  if (typeof body.private === 'boolean') repo.private = body.private;
  repo.updatedAt = ctx.forge.nowIso();
  return ok(repoJsonOf(repo));
}

export function deleteRepo(ctx: RestContext): RestResponse {
  const repo = repoOf(ctx);
  if ('status' in repo) return repo;
  ctx.forge.deleteRepo(repo.owner, repo.name);
  return { status: 204, body: null };
}

// ---------------------------------------------------------------------------------------------
// git data: refs, branches, commits
// ---------------------------------------------------------------------------------------------

export function createRef(ctx: RestContext): RestResponse {
  const repo = repoOf(ctx);
  if ('status' in repo) return repo;
  const body = bodyOf(ctx);
  const ref = typeof body.ref === 'string' ? body.ref : '';
  const sha = typeof body.sha === 'string' ? body.sha : '';
  if (!ref.startsWith('refs/') || !isObjectId(sha)) return err(422, 'ref and sha are required');
  if (!repo.objects.has(sha)) return err(422, `object ${sha} does not exist`);
  if (repo.refs.has(ref)) return err(422, `ref ${ref} already exists`);
  repo.refs.set(ref, sha);
  ctx.forge.bump(repo);
  return ok({ ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } }, 201);
}

export function getRef(ctx: RestContext): RestResponse {
  const repo = repoOf(ctx);
  if ('status' in repo) return repo;
  const ref = `refs/${ctx.params.ref ?? ''}`;
  const sha = repo.refs.get(ref);
  if (!sha) return err(404, `ref ${ref} not found`);
  return ok({ ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } });
}

export function listBranches(ctx: RestContext): RestResponse {
  const repo = repoOf(ctx);
  if ('status' in repo) return repo;
  return ok(ctx.forge.listBranches(repo).map((branch) => ({ name: branch.name, commit: { sha: branch.sha } })));
}

export function getBranch(ctx: RestContext): RestResponse {
  const repo = repoOf(ctx);
  if ('status' in repo) return repo;
  const branch = ctx.params.branch ?? '';
  const sha = ctx.forge.branchTip(repo, branch);
  if (!sha) return err(404, `branch ${branch} not found`);
  return ok({ name: branch, commit: { sha } });
}

export function listCommits(ctx: RestContext): RestResponse {
  const repo = repoOf(ctx);
  if ('status' in repo) return repo;
  const ref = ctx.query.get('sha') ?? undefined;
  const commits = ctx.forge.listCommits(repo, ref);
  return ok(
    commits.map((commit) => ({
      sha: commit.sha,
      commit: { message: commit.message, author: { name: repo.owner }, committer: { name: repo.owner } },
    })),
  );
}

// ---------------------------------------------------------------------------------------------
// contents
// ---------------------------------------------------------------------------------------------

function resolveBranchTip(repo: Repo, branch: string | undefined, forge: Forge): string | null {
  if (branch === undefined) return forge.branchTip(repo, repo.defaultBranch);
  return forge.branchTip(repo, branch);
}

export function putContents(ctx: RestContext): RestResponse {
  const repo = repoOf(ctx);
  if ('status' in repo) return repo;
  const body = bodyOf(ctx);
  const path = ctx.params.path ?? '';
  const message = typeof body.message === 'string' ? body.message : 'update';
  const contentB64 = typeof body.content === 'string' ? body.content : '';
  const branch = typeof body.branch === 'string' ? body.branch : undefined;
  const sha = typeof body.sha === 'string' ? body.sha : undefined;
  if (path === '' || contentB64 === '') return err(422, 'path and content are required');
  let content: Buffer;
  try {
    content = Buffer.from(contentB64.replace(/[\r\n\t ]+/g, ''), 'base64');
  } catch {
    return err(422, 'content is not valid base64');
  }
  const targetBranch = branch ?? repo.defaultBranch;
  const tip = resolveBranchTip(repo, branch, ctx.forge);
  const files = tip ? ctx.forge.filesOf(repo, tip) : new Map<string, { mode: string; oid: string }>();
  const existing = files.get(path);
  if (sha !== undefined) {
    if (!existing || existing.oid !== sha) return err(409, `sha ${sha} does not match the current content`);
  } else if (existing) {
    return err(422, 'sha is required to update an existing file');
  }
  const isUpdate = existing !== undefined;
  const { commit, contentSha } = ctx.forge.commitFile(repo, targetBranch, path, content, message);
  return ok(
    {
      content: {
        name: path.split('/').pop() ?? path,
        path,
        sha: contentSha,
        size: content.length,
        encoding: 'base64',
        content: content.toString('base64'),
      },
      commit: { sha: commit, message },
    },
    isUpdate ? 200 : 201,
  );
}

export function getContents(ctx: RestContext): RestResponse {
  const repo = repoOf(ctx);
  if ('status' in repo) return repo;
  const path = ctx.params.path ?? '';
  const ref = ctx.query.get('ref') ?? undefined;
  let tip: string | null;
  if (ref === undefined) {
    tip = ctx.forge.branchTip(repo, repo.defaultBranch);
  } else if (isObjectId(ref)) {
    tip = ref;
  } else {
    tip = ctx.forge.branchTip(repo, ref);
  }
  if (!tip) return err(404, `ref ${ref ?? repo.defaultBranch} not found`);
  const files = ctx.forge.filesOf(repo, tip);
  if (path === '') {
    // Root listing.
    return ok(dirListing(repo, tip, ''));
  }
  const file = files.get(path);
  if (file) {
    const blob = repo.objects.get(file.oid);
    const content = blob ? blob.data : Buffer.alloc(0);
    return ok({
      type: 'file',
      encoding: 'base64',
      content: content.toString('base64'),
      sha: file.oid,
      size: content.length,
      name: path.split('/').pop() ?? path,
      path,
    });
  }
  // A directory: any file under path/.
  const prefix = `${path}/`;
  let isDir = false;
  for (const key of files.keys()) {
    if (key.startsWith(prefix)) {
      isDir = true;
      break;
    }
  }
  if (!isDir) return err(404, `path ${path} not found`);
  return ok(dirListing(repo, tip, path));
}

function dirListing(repo: Repo, tip: string, dir: string): Array<Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>();
  const prefix = dir === '' ? '' : `${dir}/`;
  const walk = (treeOid: string, current: string): void => {
    const object = repo.objects.get(treeOid);
    if (!object || object.type !== 'tree') return;
    for (const entry of parseTree(object.data)) {
      const path = current === '' ? entry.name : `${current}/${entry.name}`;
      if (entry.mode === '40000') {
        if (path.startsWith(prefix) && path !== dir) {
          const rest = path.slice(prefix.length);
          if (!rest.includes('/')) {
            out.set(path, { type: 'dir', name: entry.name, path, sha: entry.oid });
          }
        }
        if (path === dir || dir === '' || path.startsWith(prefix) || dir.startsWith(`${path}/`)) {
          walk(entry.oid, path);
        }
      } else if (path.startsWith(prefix)) {
        const rest = path.slice(prefix.length);
        if (!rest.includes('/')) {
          out.set(path, { type: 'file', name: entry.name, path, sha: entry.oid });
        }
      }
    }
  };
  const commit = repo.objects.get(tip);
  if (!commit || commit.type !== 'commit') return [];
  walk(parseCommit(commit.data).tree, '');
  return [...out.values()].sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

export function deleteContents(ctx: RestContext): RestResponse {
  const repo = repoOf(ctx);
  if ('status' in repo) return repo;
  const body = bodyOf(ctx);
  const path = ctx.params.path ?? '';
  const message = typeof body.message === 'string' ? body.message : 'delete';
  const sha = typeof body.sha === 'string' ? body.sha : undefined;
  const branch = typeof body.branch === 'string' ? body.branch : undefined;
  const targetBranch = branch ?? repo.defaultBranch;
  const tip = resolveBranchTip(repo, branch, ctx.forge);
  if (!tip) return err(404, `ref ${targetBranch} not found`);
  const files = ctx.forge.filesOf(repo, tip);
  const existing = files.get(path);
  if (!existing) return err(404, `path ${path} not found`);
  if (sha !== undefined && existing.oid !== sha) return err(409, `sha ${sha} does not match the current content`);
  const { commit } = ctx.forge.commitFile(repo, targetBranch, path, null, message);
  return ok({ commit: { sha: commit, message } });
}

// ---------------------------------------------------------------------------------------------
// labels, issues, comments
// ---------------------------------------------------------------------------------------------

export function createLabel(ctx: RestContext): RestResponse {
  const repo = repoOf(ctx);
  if ('status' in repo) return repo;
  const body = bodyOf(ctx);
  const name = typeof body.name === 'string' ? body.name : '';
  if (name === '') return err(422, 'name is required');
  const color = typeof body.color === 'string' ? body.color : 'ededed';
  const label = ctx.forge.createLabel(repo, name, color);
  return ok({ name: label.name, color: label.color }, 201);
}

export function createIssue(ctx: RestContext): RestResponse {
  const repo = repoOf(ctx);
  if ('status' in repo) return repo;
  const body = bodyOf(ctx);
  const title = typeof body.title === 'string' ? body.title : '';
  if (title === '') return err(422, 'title is required');
  const labelNames = Array.isArray(body.labels) ? body.labels.filter((l): l is string => typeof l === 'string') : [];
  const result = ctx.forge.createIssue(repo, title, typeof body.body === 'string' ? body.body : '', labelNames);
  if ('error' in result) return err(422, result.error);
  return ok(issueJsonOf(repo, result), 201);
}

export function listIssues(ctx: RestContext): RestResponse {
  const repo = repoOf(ctx);
  if ('status' in repo) return repo;
  const issues = ctx.forge.listIssues(repo, {
    state: ctx.query.get('state') ?? undefined,
    sort: ctx.query.get('sort') ?? undefined,
    direction: ctx.query.get('direction') ?? undefined,
    perPage: intQuery(ctx, 'per_page', 30),
    page: intQuery(ctx, 'page', 1),
  });
  // The list is built from the per-issue cached JSON so a hot list is a join, not a re-serialize.
  const items = issues.map((issue) => ctx.forge.issueJsonCached(repo, issue)).join(',');
  return { status: 200, body: `[${items}]`, headers: { 'x-forged-json': '1' } };
}

export function getIssue(ctx: RestContext): RestResponse {
  const repo = repoOf(ctx);
  if ('status' in repo) return repo;
  const number = Number(ctx.params.number);
  const issue = ctx.forge.getIssue(repo, number);
  if (!issue) return err(404, `issue #${ctx.params.number} not found`);
  return { status: 200, body: ctx.forge.issueJsonCached(repo, issue) };
}

export function patchIssue(ctx: RestContext): RestResponse {
  const repo = repoOf(ctx);
  if ('status' in repo) return repo;
  const number = Number(ctx.params.number);
  const body = bodyOf(ctx);
  const issue = ctx.forge.getIssue(repo, number);
  if (!issue) return err(404, `issue #${ctx.params.number} not found`);
  if (body.state === 'closed' || body.state === 'open') {
    ctx.forge.patchIssue(repo, number, body.state);
  }
  const updated = ctx.forge.getIssue(repo, number)!;
  return { status: 200, body: ctx.forge.issueJsonCached(repo, updated) };
}

export function createComment(ctx: RestContext): RestResponse {
  const repo = repoOf(ctx);
  if ('status' in repo) return repo;
  const number = Number(ctx.params.number);
  const body = bodyOf(ctx);
  const text = typeof body.body === 'string' ? body.body : '';
  if (text === '') return err(422, 'body is required');
  const comment = ctx.forge.createComment(repo, number, text);
  if (!comment) return err(404, `issue #${ctx.params.number} not found`);
  return ok(
    {
      id: comment.id,
      node_id: Buffer.from(`comment:${repo.id}:${number}:${comment.id}`, 'utf8').toString('base64'),
      body: comment.body,
      user: { login: comment.authorLogin, id: 1000, type: 'User' },
      created_at: comment.createdAt,
      updated_at: comment.createdAt,
    },
    201,
  );
}

export function listComments(ctx: RestContext): RestResponse {
  const repo = repoOf(ctx);
  if ('status' in repo) return repo;
  const number = Number(ctx.params.number);
  if (!ctx.forge.getIssue(repo, number)) return err(404, `issue #${ctx.params.number} not found`);
  return ok(
    ctx.forge.listComments(repo, number).map((comment) => ({
      id: comment.id,
      node_id: Buffer.from(`comment:${repo.id}:${number}:${comment.id}`, 'utf8').toString('base64'),
      body: comment.body,
      user: { login: comment.authorLogin, id: 1000, type: 'User' },
      created_at: comment.createdAt,
      updated_at: comment.createdAt,
    })),
  );
}

// ---------------------------------------------------------------------------------------------
// pull requests
// ---------------------------------------------------------------------------------------------

export function createPull(ctx: RestContext): RestResponse {
  const repo = repoOf(ctx);
  if ('status' in repo) return repo;
  const body = bodyOf(ctx);
  const title = typeof body.title === 'string' ? body.title : '';
  const head = typeof body.head === 'string' ? body.head : '';
  const base = typeof body.base === 'string' ? body.base : repo.defaultBranch;
  if (title === '' || head === '') return err(422, 'title and head are required');
  const result = ctx.forge.createPull(repo, title, typeof body.body === 'string' ? body.body : '', head, base);
  if ('error' in result) return err(422, result.error);
  return ok(pullJsonOf(repo, result), 201);
}

export function listPulls(ctx: RestContext): RestResponse {
  const repo = repoOf(ctx);
  if ('status' in repo) return repo;
  const state = ctx.query.get('state') ?? 'open';
  const pulls = ctx.forge.listPulls(repo, state);
  return ok(pulls.map((pull) => pullJsonOf(repo, pull)));
}

export function getPull(ctx: RestContext): RestResponse {
  const repo = repoOf(ctx);
  if ('status' in repo) return repo;
  const number = Number(ctx.params.number);
  const pull = ctx.forge.getPull(repo, number);
  if (!pull) return err(404, `pull request #${ctx.params.number} not found`);
  return ok(pullJsonOf(repo, pull));
}

export function listPullFiles(ctx: RestContext): RestResponse {
  const repo = repoOf(ctx);
  if ('status' in repo) return repo;
  const number = Number(ctx.params.number);
  const pull = ctx.forge.getPull(repo, number);
  if (!pull) return err(404, `pull request #${ctx.params.number} not found`);
  return ok(ctx.forge.pullFiles(repo, pull));
}

export function mergePull(ctx: RestContext): RestResponse {
  const repo = repoOf(ctx);
  if ('status' in repo) return repo;
  const number = Number(ctx.params.number);
  const pull = ctx.forge.getPull(repo, number);
  if (!pull) return err(404, `pull request #${ctx.params.number} not found`);
  const body = bodyOf(ctx);
  const method = typeof body.merge_method === 'string' ? body.merge_method : 'squash';
  const result = ctx.forge.mergePull(repo, pull, method);
  if ('error' in result) return err(result.status, result.error);
  return ok({ sha: result.sha, merged: true, message: result.message });
}

export { ZERO_OID };
