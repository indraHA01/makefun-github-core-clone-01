// store.ts — the forge's whole state, in memory, content-addressed.
//
// One process, one trial: nothing is persisted to disk, because the suite
// never restarts the entry mid-trial and the state export is the env's job.
// Every object lives once in a Map keyed by its SHA-1; every repo, issue and
// pull request is a plain object; every mutation bumps the repo's version, so
// the pack cache (see below) can never serve a stale pack.
//
// The two performance structures:
//   * packCache — fetch/clone packs are built once per (repo version, wants,
//     haves, shallow, depth) and served from memory. The benchmark's 50
//     concurrent shallow clones of one tip are byte-identical, so 49 of them
//     are a cache hit. This is the forge's distinctive speed: a
//     content-addressed pack cache, not a rebuild-per-clone.
//   * issueJson — the serialized JSON of each issue, cached and invalidated
//     only when that issue is patched. The benchmark reads one issue 2,000
//     times; the hot path is a string lookup, not a re-serialization.
//
// Time is a logical clock: a monotonic counter seeded from MAKEFUN_TRIAL_NOW
// (or a fixed epoch), so commit SHAs and created_at values are deterministic
// and replay-identical. No Date.now() anywhere in a response.

import {
  buildCommit,
  buildTree,
  computeSendSet,
  flattenTree,
  hashObject,
  isDescendant,
  isObjectId,
  mergeBase,
  parseCommit,
  parseTree,
  readPack,
  writePack,
  ZERO_OID,
  type GitObject,
  type GitObjectType,
  type ObjectLookup,
} from './gitcore.ts';
import type { ForgeIdentity, ScenarioIdentity } from './scenario.ts';

export const DEFAULT_BRANCH = 'main';
export const VIEWER_PERMISSION = 'ADMIN';

export interface Label {
  name: string;
  color: string;
}

export interface Issue {
  id: number; // global database id (stable across reads)
  number: number; // per-repo, increments by 1
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  createdAt: string;
  updatedAt: string;
  authorLogin: string;
}

export interface Comment {
  id: number;
  body: string;
  createdAt: string;
  authorLogin: string;
}

export interface PullRequest {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  head: string; // branch name
  base: string; // branch name
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  createdAt: string;
  updatedAt: string;
  authorLogin: string;
}

export interface Repo {
  id: number; // databaseId
  name: string;
  owner: string;
  fullName: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdSeq: number;
  createdAt: string;
  updatedAt: string;
  // git state
  objects: Map<string, GitObject>;
  refs: Map<string, string>; // refname -> oid
  // issues / pulls
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  nextIssue: number;
  comments: Map<number, Comment[]>;
  nextCommentId: number;
  pulls: Map<number, PullRequest>;
  nextPull: number;
  // version + caches
  version: number;
  packCache: Map<string, { pack: Buffer; shallow: string[]; unshallow: string[] }>;
  issueJson: Map<number, string>;
}

const MAX_PACK_CACHE = 64;

export class Forge {
  readonly identity: ForgeIdentity;
  readonly viewer: ScenarioIdentity;
  private repos = new Map<string, Repo>(); // key: owner/name
  private nextRepoId = 1;
  private nextIssueId = 1;
  private nextPullId = 1;
  private nextCommentId = 1;
  private repoSeq = 0;
  private clockSec: number;
  private readonly clockBase: number;

  constructor(identity: ForgeIdentity) {
    this.identity = identity;
    this.viewer = identity.viewer;
    const now = process.env.MAKEFUN_TRIAL_NOW ?? '';
    const parsed = now === '' ? NaN : Date.parse(now) / 1000;
    this.clockBase = Number.isFinite(parsed) ? Math.floor(parsed) : 1739175597;
    this.clockSec = this.clockBase;
  }

  /** The next logical second (monotonic, deterministic). */
  tick(): number {
    this.clockSec += 1;
    return this.clockSec;
  }

  nowIso(): string {
    return new Date(this.tick() * 1000).toISOString();
  }

  /** The identity line every commit this forge writes carries. */
  commitIdentity(): string {
    return `${this.viewer.name} <${this.viewer.email}>`;
  }

  // -------------------------------------------------------------------------------------------
  // repositories
  // -------------------------------------------------------------------------------------------

  createRepo(name: string, isPrivate: boolean, description: string): Repo | null {
    const key = `${this.viewer.login}/${name}`;
    if (this.repos.has(key)) return null;
    const now = this.nowIso();
    const repo: Repo = {
      id: this.nextRepoId++,
      name,
      owner: this.viewer.login,
      fullName: key,
      description,
      private: isPrivate,
      defaultBranch: DEFAULT_BRANCH,
      createdSeq: this.repoSeq++,
      createdAt: now,
      updatedAt: now,
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      nextIssue: 1,
      comments: new Map(),
      nextCommentId: 1,
      pulls: new Map(),
      nextPull: 1,
      version: 0,
      packCache: new Map(),
      issueJson: new Map(),
    };
    this.repos.set(key, repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(`${owner}/${name}`);
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(`${owner}/${name}`);
  }

  listViewerRepos(): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) {
      if (repo.owner === this.viewer.login) out.push(repo);
    }
    out.sort((a, b) => a.createdSeq - b.createdSeq);
    return out;
  }

  lookup(repo: Repo): ObjectLookup {
    return (oid: string) => repo.objects.get(oid);
  }

  bump(repo: Repo): void {
    repo.version += 1;
    repo.packCache.clear();
  }

  putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  /** Build the nested tree objects for a flat path map; returns the root tree oid. */
  buildTreeFromFiles(repo: Repo, files: Map<string, { mode: string; oid: string }>): string {
    interface Node {
      files: Map<string, { mode: string; oid: string }>;
      dirs: Map<string, Node>;
    }
    const make = (): Node => ({ files: new Map(), dirs: new Map() });
    const root = make();
    for (const [path, entry] of files) {
      const segments = path.split('/');
      let node = root;
      for (let i = 0; i < segments.length - 1; i += 1) {
        const name = segments[i]!;
        if (!node.dirs.has(name)) node.dirs.set(name, make());
        node = node.dirs.get(name)!;
      }
      node.files.set(segments[segments.length - 1]!, entry);
    }
    const build = (node: Node): string => {
      const entries: { mode: string; name: string; oid: string }[] = [];
      for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
      return this.putObject(repo, 'tree', buildTree(entries));
    };
    return build(root);
  }

  /** The flat file map of a commit's tree (path -> {mode, oid}). */
  filesOf(repo: Repo, commitOid: string): Map<string, { mode: string; oid: string }> {
    const object = repo.objects.get(commitOid);
    if (!object || object.type !== 'commit') return new Map();
    return flattenTree(this.lookup(repo), parseCommit(object.data).tree);
  }

  /** Commit one file change on a branch; returns the new commit oid. */
  commitFile(
    repo: Repo,
    branch: string,
    path: string,
    content: Buffer | null, // null = delete
    message: string,
  ): { commit: string; contentSha: string | null } {
    const ref = `refs/heads/${branch}`;
    const tip = repo.refs.get(ref);
    const files = tip ? this.filesOf(repo, tip) : new Map<string, { mode: string; oid: string }>();
    let contentSha: string | null = null;
    if (content === null) {
      files.delete(path);
    } else {
      contentSha = this.putObject(repo, 'blob', content);
      files.set(path, { mode: '100644', oid: contentSha });
    }
    const tree = this.buildTreeFromFiles(repo, files);
    const timestamp = this.tick();
    const commitData = buildCommit({
      tree,
      parents: tip ? [tip] : [],
      message: message.endsWith('\n') ? message : `${message}\n`,
      author: this.commitIdentity(),
      committer: this.commitIdentity(),
      timestamp,
    });
    const commit = this.putObject(repo, 'commit', commitData);
    repo.refs.set(ref, commit);
    this.bump(repo);
    return { commit, contentSha };
  }

  /** The tip of a branch, or null when unborn. */
  branchTip(repo: Repo, branch: string): string | null {
    return repo.refs.get(`refs/heads/${branch}`) ?? null;
  }

  listBranches(repo: Repo): Array<{ name: string; sha: string }> {
    const out: Array<{ name: string; sha: string }> = [];
    for (const [ref, oid] of repo.refs) {
      if (ref.startsWith('refs/heads/')) out.push({ name: ref.slice('refs/heads/'.length), sha: oid });
    }
    out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return out;
  }

  /** Commits reachable from a ref (or the default branch), newest first. */
  listCommits(repo: Repo, ref?: string): Array<{ sha: string; message: string }> {
    const tip = ref ? (repo.refs.get(`refs/heads/${ref}`) ?? (isObjectId(ref) ? ref : null)) : this.branchTip(repo, repo.defaultBranch);
    if (!tip) return [];
    const seen = new Set<string>();
    const order: string[] = [];
    const stack = [tip];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      order.push(oid);
      for (const parent of parseCommit(object.data).parents) stack.push(parent);
    }
    // Newest first: the walk above is depth-first from the tip; sort by the
    // logical commit timestamp embedded in the commit (descending), stable by
    // discovery order for equal timestamps.
    const withTime = order.map((oid, index) => {
      const data = repo.objects.get(oid)!.data.toString('utf8');
      const match = / (\d+) \+0000\n/.exec(data);
      return { oid, ts: match ? Number(match[1]) : 0, index };
    });
    withTime.sort((a, b) => b.ts - a.ts || a.index - b.index);
    return withTime.map(({ oid }) => {
      const commit = parseCommit(repo.objects.get(oid)!.data);
      // The stored commit bytes end with one trailing newline (git's own
      // convention); the API returns the message as it was sent.
      return { sha: oid, message: commit.message.replace(/\n$/, '') };
    });
  }

  // -------------------------------------------------------------------------------------------
  // git fetch — the cached pack path
  // -------------------------------------------------------------------------------------------

  fetchPack(
    repo: Repo,
    wants: readonly string[],
    haves: readonly string[],
    clientShallow: readonly string[],
    depth?: number,
  ): { pack: Buffer; shallow: string[]; unshallow: string[] } {
    const key = JSON.stringify([
      repo.version,
      [...wants].sort(),
      [...haves].sort(),
      [...clientShallow].sort(),
      depth ?? null,
    ]);
    const cached = repo.packCache.get(key);
    if (cached) return cached;
    const send = computeSendSet(this.lookup(repo), wants, haves, clientShallow, depth);
    const pack = writePack(send.objects.values());
    const entry = { pack, shallow: send.shallow, unshallow: send.unshallow };
    if (repo.packCache.size >= MAX_PACK_CACHE) {
      const first = repo.packCache.keys().next();
      if (!first.done) repo.packCache.delete(first.value);
    }
    repo.packCache.set(key, entry);
    return entry;
  }

  /** Store the objects of a received pack. Returns the oids stored. */
  storePack(repo: Repo, pack: Buffer): string[] {
    const objects = readPack(pack, this.lookup(repo));
    const oids: string[] = [];
    for (const [oid, object] of objects) {
      if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      oids.push(oid);
    }
    if (oids.length > 0) this.bump(repo);
    return oids;
  }

  // -------------------------------------------------------------------------------------------
  // labels, issues, comments
  // -------------------------------------------------------------------------------------------

  createLabel(repo: Repo, name: string, color: string): Label {
    const label: Label = { name, color };
    repo.labels.set(name, label);
    return label;
  }

  createIssue(repo: Repo, title: string, body: string, labelNames: readonly string[]): Issue | { error: string } {
    const labels: Label[] = [];
    for (const name of labelNames) {
      const label = repo.labels.get(name);
      if (!label) return { error: `Label does not exist: ${name}` };
      labels.push(label);
    }
    const now = this.nowIso();
    const issue: Issue = {
      id: this.nextIssueId++,
      number: repo.nextIssue++,
      title,
      body,
      state: 'open',
      labels,
      createdAt: now,
      updatedAt: now,
      authorLogin: this.viewer.login,
    };
    repo.issues.set(issue.number, issue);
    repo.issueJson.set(issue.number, JSON.stringify(issueJsonOf(repo, issue)));
    return issue;
  }

  getIssue(repo: Repo, number: number): Issue | undefined {
    return repo.issues.get(number);
  }

  patchIssue(repo: Repo, number: number, state: 'open' | 'closed'): Issue | undefined {
    const issue = repo.issues.get(number);
    if (!issue) return undefined;
    issue.state = state;
    issue.updatedAt = this.nowIso();
    repo.issueJson.set(number, JSON.stringify(issueJsonOf(repo, issue)));
    return issue;
  }

  listIssues(
    repo: Repo,
    opts: { state?: string; sort?: string; direction?: string; perPage?: number; page?: number },
  ): Issue[] {
    let list = [...repo.issues.values()];
    const state = opts.state ?? 'open';
    if (state !== 'all') list = list.filter((issue) => issue.state === state);
    const direction = opts.direction ?? 'desc';
    list.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
    const perPage = opts.perPage ?? 30;
    const page = opts.page ?? 1;
    const start = (page - 1) * perPage;
    return list.slice(start, start + perPage);
  }

  issueJsonCached(repo: Repo, issue: Issue): string {
    const cached = repo.issueJson.get(issue.number);
    if (cached) return cached;
    const json = JSON.stringify(issueJsonOf(repo, issue));
    repo.issueJson.set(issue.number, json);
    return json;
  }

  createComment(repo: Repo, issueNumber: number, body: string): Comment | null {
    if (!repo.issues.has(issueNumber)) return null;
    const comment: Comment = {
      id: this.nextCommentId++,
      body,
      createdAt: this.nowIso(),
      authorLogin: this.viewer.login,
    };
    const list = repo.comments.get(issueNumber) ?? [];
    list.push(comment);
    repo.comments.set(issueNumber, list);
    return comment;
  }

  listComments(repo: Repo, issueNumber: number): Comment[] {
    return repo.comments.get(issueNumber) ?? [];
  }

  // -------------------------------------------------------------------------------------------
  // pull requests
  // -------------------------------------------------------------------------------------------

  createPull(repo: Repo, title: string, body: string, head: string, base: string): PullRequest | { error: string } {
    const headTip = this.branchTip(repo, head);
    const baseTip = this.branchTip(repo, base);
    if (!headTip) return { error: `head branch ${head} does not exist` };
    if (!baseTip) return { error: `base branch ${base} does not exist` };
    for (const existing of repo.pulls.values()) {
      if (existing.head === head && existing.base === base && existing.state === 'open') {
        return { error: `a pull request from ${head} is already open` };
      }
    }
    const now = this.nowIso();
    const pull: PullRequest = {
      id: this.nextPullId++,
      number: repo.nextPull++,
      title,
      body,
      state: 'open',
      head,
      base,
      headSha: headTip,
      baseSha: baseTip,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      createdAt: now,
      updatedAt: now,
      authorLogin: this.viewer.login,
    };
    repo.pulls.set(pull.number, pull);
    return pull;
  }

  getPull(repo: Repo, number: number): PullRequest | undefined {
    return repo.pulls.get(number);
  }

  listPulls(repo: Repo, state: string): PullRequest[] {
    const list = [...repo.pulls.values()];
    const filtered = state === 'all' ? list : list.filter((pull) => pull.state === state);
    filtered.sort((a, b) => b.number - a.number);
    return filtered;
  }

  /** The changed paths of a pull request (merge-base tree -> head tip tree). */
  pullFiles(repo: Repo, pull: PullRequest): Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> {
    const headTip = this.branchTip(repo, pull.head) ?? pull.headSha;
    const baseTip = this.branchTip(repo, pull.base) ?? pull.baseSha;
    const base = mergeBase(this.lookup(repo), baseTip, headTip) ?? baseTip;
    const baseFiles = base ? this.filesOf(repo, base) : new Map<string, { mode: string; oid: string }>();
    const headFiles = this.filesOf(repo, headTip);
    const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
    const out: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> = [];
    for (const path of [...paths].sort()) {
      const inBase = baseFiles.get(path);
      const inHead = headFiles.get(path);
      if (!inBase && inHead) {
        const content = repo.objects.get(inHead.oid)?.data.toString('utf8') ?? '';
        const additions = countLines(content);
        out.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
      } else if (inBase && !inHead) {
        const content = repo.objects.get(inBase.oid)?.data.toString('utf8') ?? '';
        const deletions = countLines(content);
        out.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
      } else if (inBase && inHead && inBase.oid !== inHead.oid) {
        const oldContent = repo.objects.get(inBase.oid)?.data.toString('utf8') ?? '';
        const newContent = repo.objects.get(inHead.oid)?.data.toString('utf8') ?? '';
        const { additions, deletions } = diffLines(oldContent, newContent);
        out.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
      }
    }
    return out;
  }

  /** Whether a pull request can be squash-merged without conflict. */
  pullMergeable(repo: Repo, pull: PullRequest): boolean {
    return this.mergeConflict(repo, pull) === null;
  }

  /** The conflicting path of a pull request, or null when it merges cleanly. */
  mergeConflict(repo: Repo, pull: PullRequest): string | null {
    const headTip = this.branchTip(repo, pull.head) ?? pull.headSha;
    const baseTip = this.branchTip(repo, pull.base) ?? pull.baseSha;
    const base = mergeBase(this.lookup(repo), baseTip, headTip);
    if (!base) return null;
    const baseFiles = this.filesOf(repo, base);
    const headFiles = this.filesOf(repo, headTip);
    const currentFiles = this.filesOf(repo, baseTip);
    for (const [path, headEntry] of headFiles) {
      const mbEntry = baseFiles.get(path);
      if (mbEntry && mbEntry.oid === headEntry.oid) continue; // unchanged by the PR
      if (!mbEntry) {
        // Added by the PR; conflicts only if the base also added it differently.
        const current = currentFiles.get(path);
        if (current && current.oid !== headEntry.oid) return path;
        continue;
      }
      // Modified by the PR; conflicts if the base also changed or deleted it.
      const current = currentFiles.get(path);
      if (!current) return path; // deleted on the base, modified on the head
      if (current.oid !== mbEntry.oid) return path; // changed on both sides
    }
    for (const [path] of baseFiles) {
      if (!headFiles.has(path)) {
        // Deleted by the PR; conflicts if the base changed it.
        const current = currentFiles.get(path);
        if (current && current.oid !== baseFiles.get(path)!.oid) return path;
      }
    }
    return null;
  }

  /** Squash-merge a pull request onto its base branch. Returns the merge commit or an error. */
  mergePull(repo: Repo, pull: PullRequest, method: string): { sha: string; message: string } | { error: string; status: number } {
    if (pull.state !== 'open' || pull.merged) return { error: 'pull request is not open', status: 405 };
    if (method !== 'squash' && method !== 'merge' && method !== 'rebase') {
      return { error: `unsupported merge_method ${method}`, status: 405 };
    }
    const conflict = this.mergeConflict(repo, pull);
    if (conflict) return { error: `merge conflict on ${conflict}`, status: 405 };
    const headTip = this.branchTip(repo, pull.head) ?? pull.headSha;
    const baseTip = this.branchTip(repo, pull.base) ?? pull.baseSha;
    const base = mergeBase(this.lookup(repo), baseTip, headTip) ?? baseTip;
    const baseFiles = base ? this.filesOf(repo, base) : new Map<string, { mode: string; oid: string }>();
    const headFiles = this.filesOf(repo, headTip);
    const currentFiles = this.filesOf(repo, baseTip);
    // Apply the PR's changes onto the current base tree.
    for (const [path, headEntry] of headFiles) {
      const mbEntry = baseFiles.get(path);
      if (mbEntry && mbEntry.oid === headEntry.oid) continue;
      currentFiles.set(path, headEntry);
    }
    for (const [path] of baseFiles) {
      if (!headFiles.has(path)) currentFiles.delete(path);
    }
    const tree = this.buildTreeFromFiles(repo, currentFiles);
    const timestamp = this.tick();
    const message = `Merge pull request #${pull.number} from ${repo.owner}/${pull.head}\n\n${pull.title}\n`;
    const commitData = buildCommit({
      tree,
      parents: [baseTip],
      message,
      author: this.commitIdentity(),
      committer: this.commitIdentity(),
      timestamp,
    });
    const sha = this.putObject(repo, 'commit', commitData);
    repo.refs.set(`refs/heads/${pull.base}`, sha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = new Date(timestamp * 1000).toISOString();
    pull.mergeCommitSha = sha;
    pull.updatedAt = pull.mergedAt;
    this.bump(repo);
    return { sha, message: `Pull request #${pull.number} merged` };
  }
}

// ---------------------------------------------------------------------------------------------
// JSON shapes (the GitHub v3 object forms the checks assert)
// ---------------------------------------------------------------------------------------------

export function repoJsonOf(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: globalId('repo', String(repo.id)),
    name: repo.name,
    full_name: repo.fullName,
    owner: { login: repo.owner, id: 1000, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    html_url: `https://github.com/${repo.fullName}`,
    url: `/repos/${repo.fullName}`,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
  };
}

export function issueJsonOf(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: globalId('issue', `${repo.id}:${issue.number}`),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((label) => ({ name: label.name, color: label.color })),
    user: { login: issue.authorLogin, id: 1000, type: 'User' },
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    html_url: `https://github.com/${repo.fullName}/issues/${issue.number}`,
    url: `/repos/${repo.fullName}/issues/${issue.number}`,
    comments: 0,
  };
}

export function pullJsonOf(repo: Repo, pull: PullRequest): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: globalId('pr', `${repo.id}:${pull.number}`),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: { ref: pull.head, sha: pull.headSha, label: `${repo.owner}:${pull.head}` },
    base: { ref: pull.base, sha: pull.baseSha, label: `${repo.owner}:${pull.base}` },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: null,
    user: { login: pull.authorLogin, id: 1000, type: 'User' },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    html_url: `https://github.com/${repo.fullName}/pull/${pull.number}`,
    url: `/repos/${repo.fullName}/pulls/${pull.number}`,
  };
}

/** An opaque, stable Relay global id (base64 of a typed key — never the bare number). */
export function globalId(kind: string, key: string): string {
  return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64');
}

export function parseGlobalId(id: string): { kind: string; key: string } | null {
  try {
    const decoded = Buffer.from(id, 'base64').toString('utf8');
    const colon = decoded.indexOf(':');
    if (colon < 0) return null;
    return { kind: decoded.slice(0, colon), key: decoded.slice(colon + 1) };
  } catch {
    return null;
  }
}

function countLines(content: string): number {
  if (content === '') return 0;
  const lines = content.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.length;
}

/** Added/removed line counts from an LCS diff (small files only; the suite's are). */
export function diffLines(oldContent: string, newContent: string): { additions: number; deletions: number } {
  const a = oldContent === '' ? [] : oldContent.split('\n');
  const b = newContent === '' ? [] : newContent.split('\n');
  if (a.length > 0 && a[a.length - 1] === '') a.pop();
  if (b.length > 0 && b[b.length - 1] === '') b.pop();
  const n = a.length;
  const m = b.length;
  // LCS length via a single rolling row.
  let prev = new Array<number>(m + 1).fill(0);
  let curr = new Array<number>(m + 1).fill(0);
  for (let i = 1; i <= n; i += 1) {
    for (let j = 1; j <= m; j += 1) {
      curr[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], curr[j - 1]);
    }
    [prev, curr] = [curr, prev];
  }
  const lcs = prev[m];
  return { additions: m - lcs, deletions: n - lcs };
}

export { ZERO_OID };
export type { GitObject };
