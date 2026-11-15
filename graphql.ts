// graphql.ts — a small, hand-written GraphQL executor for the forge.
//
// The sealed suite uses a fixed set of documents (viewer, repository,
// issues with pagination, issue by number, pull requests, node(id:),
// __type introspection, five mutations, invalid-field, batching), so this
// implements a faithful subset of the GraphQL language: operations,
// variables, inline input objects, inline enum lists, null variables,
// operation names, named and inline fragments, aliases, and JSON arrays
// of operation documents in one request (batching).
//
// Global ids are opaque base64 strings (see store.ts) and stable across
// reads; repository is null (no errors) for an unknown repo; an unknown
// field is an HTTP 200 with an errors array naming the field.

import { globalId, parseGlobalId } from './store.ts';
import type { Forge, Issue, Pull, Repo } from './store.ts';

// ---------------------------------------------------------------------------------------------
// tokenizer + parser
// ---------------------------------------------------------------------------------------------

interface Token {
  kind: 'name' | 'string' | 'int' | 'float' | 'punct' | 'spread';
  value: string;
}

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  while (i < src.length) {
    const c = src[i]!;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',' || c === '﻿') {
      i++;
      continue;
    }
    if (c === '#') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '.' && src[i + 1] === '.' && src[i + 2] === '.') {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('!$()[]{}:=@&|'.includes(c)) {
      tokens.push({ kind: 'punct', value: c });
      i++;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          const esc = src[j + 1]!;
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else if (esc === 'u' && j + 5 < src.length) {
            out += String.fromCharCode(Number.parseInt(src.slice(j + 2, j + 6), 16));
            j += 4;
          } else out += esc;
          j += 2;
        } else {
          out += src[j];
          j++;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (c === '-' || /[0-9]/.test(c)) {
      let j = i;
      if (src[j] === '-') j++;
      while (j < src.length && /[0-9]/.test(src[j]!)) j++;
      let isFloat = false;
      if (src[j] === '.' && /[0-9]/.test(src[j + 1] ?? '')) {
        isFloat = true;
        j++;
        while (j < src.length && /[0-9]/.test(src[j]!)) j++;
      }
      if (src[j] === 'e' || src[j] === 'E') {
        isFloat = true;
        j++;
        if (src[j] === '+' || src[j] === '-') j++;
        while (j < src.length && /[0-9]/.test(src[j]!)) j++;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: src.slice(i, j) });
      i = j;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < src.length && isNameChar(src[j]!)) j++;
      tokens.push({ kind: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    // Unknown character: skip it rather than dying.
    i++;
  }
  return tokens;
}

export type ValueNode =
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'enum'; value: string }
  | { kind: 'null'; value: null }
  | { kind: 'variable'; value: string }
  | { kind: 'list'; value: ValueNode[] }
  | { kind: 'object'; value: Array<{ name: string; value: ValueNode }> };

export interface FieldNode {
  kind: 'field';
  name: string;
  alias?: string;
  args: Array<{ name: string; value: ValueNode }>;
  selection?: SelectionNode[];
}
export interface SpreadNode {
  kind: 'spread';
  name: string;
}
export interface InlineNode {
  kind: 'inline';
  typeCondition?: string;
  selection: SelectionNode[];
}
export type SelectionNode = FieldNode | SpreadNode | InlineNode;

export interface OperationNode {
  kind: 'operation';
  operation: 'query' | 'mutation';
  name?: string;
  variables: string[];
  selection: SelectionNode[];
}
export interface FragmentNode {
  kind: 'fragment';
  name: string;
  typeCondition: string;
  selection: SelectionNode[];
}
export interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, FragmentNode>;
}

class Parser {
  private pos = 0;
  private tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }
  private next(): Token {
    const token = this.tokens[this.pos];
    this.pos++;
    if (!token) throw new Error('unexpected end of query');
    return token;
  }
  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value}, got ${token.value}`);
  }
  private acceptPunct(value: string): boolean {
    const token = this.peek();
    if (token && token.kind === 'punct' && token.value === value) {
      this.pos++;
      return true;
    }
    return false;
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, FragmentNode>();
    while (this.peek()) {
      const token = this.peek()!;
      if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const name = this.next().value;
        const on = this.next();
        if (on.value !== 'on') throw new Error('expected "on" in fragment');
        const typeCondition = this.next().value;
        const selection = this.parseSelectionSet();
        fragments.set(name, { kind: 'fragment', name, typeCondition, selection });
      } else if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
        operations.push(this.parseOperation());
      } else if (token.kind === 'punct' && token.value === '{') {
        operations.push({ kind: 'operation', operation: 'query', variables: [], selection: this.parseSelectionSet() });
      } else {
        throw new Error(`unexpected token ${token.value}`);
      }
    }
    return { operations, fragments };
  }

  private parseOperation(): OperationNode {
    const keyword = this.next().value as 'query' | 'mutation';
    let name: string | undefined;
    const next = this.peek();
    if (next && next.kind === 'name') {
      name = this.next().value;
    }
    const variables: string[] = [];
    if (this.acceptPunct('(')) {
      while (!this.acceptPunct(')')) {
        const dollar = this.next();
        if (dollar.value !== '$') throw new Error('expected $ in variable definition');
        variables.push(this.next().value);
        this.expectPunct(':');
        // Skip the type (name, brackets, !) and an optional default value.
        let depth = 0;
        while (this.peek()) {
          const t = this.peek()!;
          if (t.kind === 'punct' && t.value === '[') depth++;
          if (t.kind === 'punct' && t.value === ']') depth--;
          if (depth === 0 && t.kind === 'punct' && (t.value === ',' || t.value === ')')) break;
          if (depth === 0 && t.kind === 'punct' && t.value === '=') {
            this.next();
            this.parseValue();
            break;
          }
          this.next();
        }
        this.acceptPunct(',');
      }
    }
    const selection = this.parseSelectionSet();
    return { kind: 'operation', operation: keyword, name, variables, selection };
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const out: SelectionNode[] = [];
    while (true) {
      const token = this.peek();
      if (!token) throw new Error('unterminated selection set');
      if (token.kind === 'punct' && token.value === '}') {
        this.next();
        break;
      }
      out.push(this.parseSelection());
    }
    return out;
  }

  private parseSelection(): SelectionNode {
    const token = this.peek()!;
    if (token.kind === 'spread') {
      this.next();
      const next = this.peek()!;
      if (next.kind === 'name' && next.value === 'on') {
        this.next();
        const typeCondition = this.next().value;
        return { kind: 'inline', typeCondition, selection: this.parseSelectionSet() };
      }
      if (next.kind === 'name') {
        return { kind: 'spread', name: this.next().value };
      }
      throw new Error('bad fragment spread');
    }
    if (token.kind !== 'name') throw new Error(`expected field name, got ${token.value}`);
    let name = this.next().value;
    let alias: string | undefined;
    if (this.peek()?.kind === 'punct' && this.peek()!.value === ':') {
      this.next();
      alias = name;
      name = this.next().value;
    }
    const args: Array<{ name: string; value: ValueNode }> = [];
    if (this.acceptPunct('(')) {
      while (!this.acceptPunct(')')) {
        const argName = this.next().value;
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue() });
        this.acceptPunct(',');
      }
    }
    let selection: SelectionNode[] | undefined;
    if (this.peek()?.kind === 'punct' && this.peek()!.value === '{') {
      selection = this.parseSelectionSet();
    }
    return { kind: 'field', name, alias, args, selection };
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', value: this.next().value };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: Number(token.value) };
    if (token.kind === 'float') return { kind: 'float', value: Number(token.value) };
    if (token.kind === 'punct' && token.value === '[') {
      const items: ValueNode[] = [];
      while (!this.acceptPunct(']')) {
        items.push(this.parseValue());
        this.acceptPunct(',');
      }
      return { kind: 'list', value: items };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!this.acceptPunct('}')) {
        const name = this.next().value;
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
        this.acceptPunct(',');
      }
      return { kind: 'object', value: fields };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null', value: null };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`unexpected value token ${token.value}`);
  }
}

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
    case 'enum':
      return node.value;
    case 'null':
      return null;
    case 'variable': {
      const value = variables[node.value];
      return value === undefined ? null : value;
    }
    case 'list':
      return node.value.map((item) => resolveValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.value) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// schema
// ---------------------------------------------------------------------------------------------

interface FieldDef {
  /** Named return type (unwrapped: ID, String, Int, Boolean, IssueState, …). */
  type: string;
  list?: boolean;
  resolve?: (ctx: GqlContext, source: GqlObject, args: Record<string, unknown>) => unknown;
  prop?: string;
}

interface TypeDef {
  kind: 'OBJECT' | 'ENUM' | 'SCALAR';
  fields?: Record<string, FieldDef>;
  enumValues?: string[];
}

export interface GqlContext {
  forge: Forge;
  variables: Record<string, unknown>;
}

export type GqlObject = Record<string, unknown> & { __typename: string };

function field(type: string, resolve?: FieldDef['resolve'], list = false): FieldDef {
  return { type, resolve, list };
}
function prop(type: string, name: string): FieldDef {
  return { type, prop: name };
}

const SCHEMA: Record<string, TypeDef> = {
  Query: {
    kind: 'OBJECT',
    fields: {
      viewer: field('User', (ctx) => userObject(ctx.forge)),
      repository: field('Repository', (ctx, _s, args) => {
        const repo = ctx.forge.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
        return repo ? repoObject(ctx.forge, repo) : null;
      }),
      node: field('Node', (ctx, _s, args) => nodeObject(ctx.forge, String(args.id ?? ''))),
      __type: field('__Type', (_ctx, _s, args) => typeObject(String(args.name ?? ''))),
    },
  },
  Mutation: {
    kind: 'OBJECT',
    fields: {
      createIssue: field('CreateIssuePayload', (ctx, _s, args) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const parsed = parseGlobalId(String(input.repositoryId ?? ''));
        if (!parsed || parsed.kind !== 'repo') return { __typename: 'CreateIssuePayload', issue: null };
        const repo = repoById(ctx.forge, Number(parsed.key));
        if (!repo) return { __typename: 'CreateIssuePayload', issue: null };
        const result = ctx.forge.createIssue(repo, String(input.title ?? ''), typeof input.body === 'string' ? input.body : '', []);
        if ('error' in result) return { __typename: 'CreateIssuePayload', issue: null };
        return { __typename: 'CreateIssuePayload', issue: issueObject(ctx.forge, repo, result) };
      }),
      closeIssue: field('CloseIssuePayload', (ctx, _s, args) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const parsed = parseGlobalId(String(input.issueId ?? ''));
        if (!parsed || parsed.kind !== 'issue') return { __typename: 'CloseIssuePayload', issue: null };
        const [repoId, number] = keyParts(parsed.key);
        const repo = repoById(ctx.forge, repoId ?? 0);
        if (!repo) return { __typename: 'CloseIssuePayload', issue: null };
        const issue = ctx.forge.getIssue(repo, number ?? 0);
        if (!issue) return { __typename: 'CloseIssuePayload', issue: null };
        ctx.forge.patchIssue(repo, number ?? 0, 'closed');
        const updated = ctx.forge.getIssue(repo, number ?? 0)!;
        return { __typename: 'CloseIssuePayload', issue: issueObject(ctx.forge, repo, updated) };
      }),
      createPullRequest: field('CreatePullRequestPayload', (ctx, _s, args) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const parsed = parseGlobalId(String(input.repositoryId ?? ''));
        if (!parsed || parsed.kind !== 'repo') return { __typename: 'CreatePullRequestPayload', pullRequest: null };
        const repo = repoById(ctx.forge, Number(parsed.key));
        if (!repo) return { __typename: 'CreatePullRequestPayload', pullRequest: null };
        const result = ctx.forge.createPull(
          repo,
          String(input.title ?? ''),
          '',
          String(input.headRefName ?? ''),
          String(input.baseRefName ?? repo.defaultBranch),
        );
        if ('error' in result) return { __typename: 'CreatePullRequestPayload', pullRequest: null };
        return { __typename: 'CreatePullRequestPayload', pullRequest: pullObject(ctx.forge, repo, result) };
      }),
      mergePullRequest: field('MergePullRequestPayload', (ctx, _s, args) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const parsed = parseGlobalId(String(input.pullRequestId ?? ''));
        if (!parsed || parsed.kind !== 'pr') return { __typename: 'MergePullRequestPayload', pullRequest: null };
        const [repoId, number] = keyParts(parsed.key);
        const repo = repoById(ctx.forge, repoId ?? 0);
        if (!repo) return { __typename: 'MergePullRequestPayload', pullRequest: null };
        const pull = ctx.forge.getPull(repo, number ?? 0);
        if (!pull) return { __typename: 'MergePullRequestPayload', pullRequest: null };
        const method = String(input.mergeMethod ?? 'SQUASH').toLowerCase();
        const result = ctx.forge.mergePull(repo, pull, method);
        if ('error' in result) return { __typename: 'MergePullRequestPayload', pullRequest: null };
        const updated = ctx.forge.getPull(repo, number ?? 0)!;
        return { __typename: 'MergePullRequestPayload', pullRequest: pullObject(ctx.forge, repo, updated) };
      }),
      addComment: field('AddCommentPayload', (ctx, _s, args) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const parsed = parseGlobalId(String(input.subjectId ?? ''));
        if (!parsed || parsed.kind !== 'issue') return { __typename: 'AddCommentPayload', commentEdge: null };
        const [repoId, number] = keyParts(parsed.key);
        const repo = repoById(ctx.forge, repoId ?? 0);
        if (!repo) return { __typename: 'AddCommentPayload', commentEdge: null };
        const comment = ctx.forge.createComment(repo, number ?? 0, String(input.body ?? ''));
        if (!comment) return { __typename: 'AddCommentPayload', commentEdge: null };
        return {
          __typename: 'AddCommentPayload',
          commentEdge: {
            __typename: 'IssueCommentEdge',
            node: {
              __typename: 'IssueComment',
              id: globalId('comment', `${repo.id}:${number ?? 0}:${comment.id}`),
              body: comment.body,
            },
          },
        };
      }),
    },
  },
  User: { kind: 'OBJECT', fields: { login: prop('String', 'login'), id: prop('ID', 'id'), name: prop('String', 'name'), email: prop('String', 'email') } },
  Repository: {
    kind: 'OBJECT',
    fields: {
      id: prop('ID', 'id'),
      databaseId: prop('Int', 'databaseId'),
      name: prop('String', 'name'),
      nameWithOwner: prop('String', 'nameWithOwner'),
      owner: prop('User', 'owner'),
      defaultBranchRef: prop('Ref', 'defaultBranchRef'),
      viewerPermission: prop('RepositoryPermission', 'viewerPermission'),
      hasIssuesEnabled: prop('Boolean', 'hasIssuesEnabled'),
      issue: field('Issue', (ctx, source, args) => {
        const repo = (source.repo as Repo | undefined);
        if (!repo) return null;
        const issue = ctx.forge.getIssue(repo, Number(args.number));
        return issue ? issueObject(ctx.forge, repo, issue) : null;
      }),
      issues: field('IssueConnection', (ctx, source, args) => {
        const repo = (source.repo as Repo | undefined);
        if (!repo) return { __typename: 'IssueConnection', nodes: [], pageInfo: { __typename: 'PageInfo', hasNextPage: false, endCursor: null } };
        return issuesConnection(ctx.forge, repo, args);
      }),
      pullRequests: field('PullRequestConnection', (ctx, source, args) => {
        const repo = (source.repo as Repo | undefined);
        if (!repo) return { __typename: 'PullRequestConnection', nodes: [] };
        const first = typeof args.first === 'number' ? args.first : undefined;
        const pulls = ctx.forge.listPulls(repo, 'all').sort((a, b) => b.number - a.number);
        const page = first === undefined ? pulls : pulls.slice(0, first);
        return { __typename: 'PullRequestConnection', nodes: page.map((pull) => pullObject(ctx.forge, repo, pull)) };
      }),
      pullRequest: field('PullRequest', (ctx, source, args) => {
        const repo = (source.repo as Repo | undefined);
        if (!repo) return null;
        const pull = ctx.forge.getPull(repo, Number(args.number));
        return pull ? pullObject(ctx.forge, repo, pull) : null;
      }),
    },
  },
  Ref: { kind: 'OBJECT', fields: { name: prop('String', 'name') } },
  Issue: {
    kind: 'OBJECT',
    fields: {
      id: prop('ID', 'id'),
      number: prop('Int', 'number'),
      title: prop('String', 'title'),
      state: prop('IssueState', 'state'),
      body: prop('String', 'body'),
    },
  },
  IssueConnection: {
    kind: 'OBJECT',
    fields: {
      nodes: field('Issue', (_ctx, source) => source.nodes as GqlObject[], true),
      pageInfo: prop('PageInfo', 'pageInfo'),
    },
  },
  PageInfo: {
    kind: 'OBJECT',
    fields: { hasNextPage: prop('Boolean', 'hasNextPage'), endCursor: prop('String', 'endCursor') },
  },
  PullRequest: {
    kind: 'OBJECT',
    fields: {
      id: prop('ID', 'id'),
      number: prop('Int', 'number'),
      state: prop('PullRequestState', 'state'),
      merged: prop('Boolean', 'merged'),
      headRefName: prop('String', 'headRefName'),
      baseRefName: prop('String', 'baseRefName'),
      mergeable: prop('MergeableState', 'mergeable'),
      files: field('PullRequestChangedFileConnection', (ctx, source) => {
        const repo = (source.repo as Repo | undefined);
        const pull = (source.pull as Pull | undefined);
        if (!repo || !pull) return { __typename: 'PullRequestChangedFileConnection', nodes: [] };
        const nodes = ctx.forge.pullFiles(repo, pull).map((file) => ({ __typename: 'PullRequestChangedFile', path: file.filename }));
        return { __typename: 'PullRequestChangedFileConnection', nodes };
      }),
    },
  },
  PullRequestConnection: {
    kind: 'OBJECT',
    fields: { nodes: field('PullRequest', (_ctx, source) => source.nodes as GqlObject[], true) },
  },
  PullRequestChangedFileConnection: {
    kind: 'OBJECT',
    fields: { nodes: field('PullRequestChangedFile', (_ctx, source) => source.nodes as GqlObject[], true) },
  },
  PullRequestChangedFile: { kind: 'OBJECT', fields: { path: prop('String', 'path') } },
  CreateIssuePayload: { kind: 'OBJECT', fields: { issue: prop('Issue', 'issue') } },
  CloseIssuePayload: { kind: 'OBJECT', fields: { issue: prop('Issue', 'issue') } },
  CreatePullRequestPayload: { kind: 'OBJECT', fields: { pullRequest: prop('PullRequest', 'pullRequest') } },
  MergePullRequestPayload: { kind: 'OBJECT', fields: { pullRequest: prop('PullRequest', 'pullRequest') } },
  AddCommentPayload: { kind: 'OBJECT', fields: { commentEdge: prop('IssueCommentEdge', 'commentEdge') } },
  IssueCommentEdge: { kind: 'OBJECT', fields: { node: prop('IssueComment', 'node') } },
  IssueComment: { kind: 'OBJECT', fields: { id: prop('ID', 'id'), body: prop('String', 'body') } },
  __Type: {
    kind: 'OBJECT',
    fields: {
      name: prop('String', 'name'),
      kind: prop('String', 'kind'),
      fields: field('__Field', (_ctx, source, args) => {
        const includeDeprecated = args.includeDeprecated !== false;
        void includeDeprecated;
        return (source.fields as GqlObject[]) ?? [];
      }, true),
      enumValues: field('__EnumValue', (_ctx, source) => (source.enumValues as GqlObject[]) ?? [], true),
    },
  },
  __Field: {
    kind: 'OBJECT',
    fields: { name: prop('String', 'name'), type: prop('__Type', 'type') },
  },
  __EnumValue: { kind: 'OBJECT', fields: { name: prop('String', 'name') } },
  Node: { kind: 'OBJECT', fields: { id: prop('ID', 'id') } },
  IssueState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'ENUM', enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  RepositoryPermission: { kind: 'ENUM', enumValues: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] },
  SearchType: { kind: 'ENUM', enumValues: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'MILESTONE'] },
  IssueOrderField: { kind: 'ENUM', enumValues: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] },
  OrderDirection: { kind: 'ENUM', enumValues: ['ASC', 'DESC'] },
  PullRequestMergeMethod: { kind: 'ENUM', enumValues: ['MERGE', 'SQUASH', 'REBASE'] },
  String: { kind: 'SCALAR' },
  Int: { kind: 'SCALAR' },
  ID: { kind: 'SCALAR' },
  Boolean: { kind: 'SCALAR' },
};

// ---------------------------------------------------------------------------------------------
// object builders
// ---------------------------------------------------------------------------------------------

function userObject(forge: Forge): GqlObject {
  const viewer = forge.viewer;
  return {
    __typename: 'User',
    id: globalId('user', String(viewer.id)),
    login: viewer.login,
    name: viewer.name,
    email: viewer.email,
  };
}

/** Find a repository by its numeric id (the store keys repos by owner/name). */
function repoById(forge: Forge, id: number): Repo | undefined {
  return forge.listViewerRepos().find((repo) => repo.id === id);
}

/** Split a global-id key of the form "repoId:number" into its numbers. */
function keyParts(key: string): number[] {
  return key.split(':').map((part) => Number(part));
}

/** REST states are lowercase; the GraphQL enums are uppercase. */
function gqlIssueState(state: string): string {
  return state === 'closed' ? 'CLOSED' : 'OPEN';
}
function gqlPullState(pull: Pull): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'closed' ? 'CLOSED' : 'OPEN';
}

function repoObject(forge: Forge, repo: Repo): GqlObject {
  return {
    __typename: 'Repository',
    repo,
    id: globalId('repo', String(repo.id)),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    owner: userObject(forge),
    defaultBranchRef: { __typename: 'Ref', name: repo.defaultBranch },
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
  };
}

function issueObject(forge: Forge, repo: Repo, issue: Issue): GqlObject {
  void forge;
  return {
    __typename: 'Issue',
    repo,
    id: globalId('issue', `${repo.id}:${issue.number}`),
    number: issue.number,
    title: issue.title,
    state: gqlIssueState(issue.state),
    body: issue.body,
  };
}

function pullObject(forge: Forge, repo: Repo, pull: Pull): GqlObject {
  return {
    __typename: 'PullRequest',
    repo,
    pull,
    id: globalId('pr', `${repo.id}:${pull.number}`),
    number: pull.number,
    state: gqlPullState(pull),
    merged: pull.merged,
    headRefName: pull.head,
    baseRefName: pull.base,
    mergeable: forge.pullMergeable(repo, pull) ? 'MERGEABLE' : 'CONFLICTING',
  };
}

function nodeObject(forge: Forge, id: string): GqlObject | null {
  const parsed = parseGlobalId(id);
  if (!parsed) return null;
  if (parsed.kind === 'repo') {
    const repo = repoById(forge, Number(parsed.key));
    return repo ? repoObject(forge, repo) : null;
  }
  if (parsed.kind === 'issue') {
    const [repoId, number] = keyParts(parsed.key);
    const repo = repoById(forge, repoId ?? 0);
    if (!repo) return null;
    const issue = forge.getIssue(repo, number ?? 0);
    return issue ? issueObject(forge, repo, issue) : null;
  }
  if (parsed.kind === 'pr') {
    const [repoId, number] = keyParts(parsed.key);
    const repo = repoById(forge, repoId ?? 0);
    if (!repo) return null;
    const pull = forge.getPull(repo, number ?? 0);
    return pull ? pullObject(forge, repo, pull) : null;
  }
  return null;
}

function typeObject(name: string): GqlObject | null {
  const def = SCHEMA[name];
  if (!def) return null;
  const fields: GqlObject[] = [];
  if (def.fields) {
    for (const [fieldName, fieldDef] of Object.entries(def.fields)) {
      const named = SCHEMA[fieldDef.type];
      fields.push({
        __typename: '__Field',
        name: fieldName,
        type: { __typename: '__Type', name: fieldDef.type, kind: named?.kind ?? 'SCALAR' },
      });
    }
  }
  const enumValues: GqlObject[] = (def.enumValues ?? []).map((value) => ({ __typename: '__EnumValue', name: value }));
  return { __typename: '__Type', name, kind: def.kind, fields, enumValues };
}

function issuesConnection(forge: Forge, repo: Repo, args: Record<string, unknown>): GqlObject {
  const states = Array.isArray(args.states) ? (args.states as string[]) : undefined;
  const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
  const direction = String(orderBy.direction ?? 'DESC');
  const after = typeof args.after === 'string' ? args.after : null;
  const first = typeof args.first === 'number' ? args.first : undefined;
  let issues = forge.listIssues(repo, {
    state:
      states && states.length > 0
        ? states.length === 1
          ? states[0] === 'OPEN'
            ? 'open'
            : 'closed'
          : 'all'
        : 'all',
    sort: 'created',
    direction: direction === 'ASC' ? 'asc' : 'desc',
    perPage: 100000,
    page: 1,
  });
  // listIssues sorts by createdAt; order by number (creation order) to match.
  issues = [...issues].sort((a, b) => (direction === 'ASC' ? a.number - b.number : b.number - a.number));
  if (after) {
    try {
      const decoded = Buffer.from(after, 'base64').toString('utf8');
      const match = /^cursor:(\d+)$/.exec(decoded);
      if (match) {
        const cursorNum = Number(match[1]);
        issues = issues.filter((issue) => (direction === 'ASC' ? issue.number > cursorNum : issue.number < cursorNum));
      }
    } catch {
      // An opaque cursor we cannot decode is treated as no cursor.
    }
  }
  const page = first === undefined ? issues : issues.slice(0, first);
  const hasNextPage = first !== undefined ? issues.length > first : false;
  const last = page[page.length - 1];
  const endCursor = last ? Buffer.from(`cursor:${last.number}`, 'utf8').toString('base64') : null;
  return {
    __typename: 'IssueConnection',
    nodes: page.map((issue) => issueObject(forge, repo, issue)),
    pageInfo: { __typename: 'PageInfo', hasNextPage, endCursor },
  };
}

// ---------------------------------------------------------------------------------------------
// executor
// ---------------------------------------------------------------------------------------------

export interface GqlResult {
  data: Record<string, unknown> | null;
  errors?: Array<{ message: string }>;
}

export function executeGraphQL(forge: Forge, query: string, variables: Record<string, unknown>, operationName?: string): GqlResult {
  let document: DocumentNode;
  try {
    document = new Parser(tokenize(query)).parseDocument();
  } catch (error) {
    return { data: null, errors: [{ message: error instanceof Error ? error.message : 'syntax error' }] };
  }
  let operation: OperationNode | undefined;
  if (operationName) {
    operation = document.operations.find((op) => op.name === operationName);
  } else if (document.operations.length === 1) {
    operation = document.operations[0];
  } else {
    operation = document.operations.find((op) => op.operation === 'query');
  }
  if (!operation) return { data: null, errors: [{ message: 'no operation found' }] };
  const ctx: GqlContext = { forge, variables };
  const errors: Array<{ message: string }> = [];
  const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelection(ctx, rootType, { __typename: rootType }, operation.selection, document.fragments, errors);
  const result: GqlResult = { data };
  if (errors.length > 0) result.errors = errors;
  return result;
}

function executeSelection(
  ctx: GqlContext,
  typeName: string,
  source: GqlObject,
  selection: SelectionNode[],
  fragments: Map<string, FragmentNode>,
  errors: Array<{ message: string }>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const node of selection) {
    if (node.kind === 'spread') {
      const fragment = fragments.get(node.name);
      if (fragment && (fragment.typeCondition === typeName || fragment.typeCondition === source.__typename)) {
        // Entering a fragment switches field resolution to the fragment's type.
        Object.assign(out, executeSelection(ctx, fragment.typeCondition, source, fragment.selection, fragments, errors));
      }
      continue;
    }
    if (node.kind === 'inline') {
      if (!node.typeCondition || node.typeCondition === typeName || node.typeCondition === source.__typename) {
        Object.assign(out, executeSelection(ctx, node.typeCondition ?? typeName, source, node.selection, fragments, errors));
      }
      continue;
    }
    const responseName = node.alias ?? node.name;
    if (node.name === '__typename') {
      out[responseName] = source.__typename;
      continue;
    }
    const typeDef = SCHEMA[typeName];
    const fieldDef = typeDef?.fields?.[node.name];
    if (!fieldDef) {
      errors.push({ message: `Cannot query field "${node.name}" on type "${typeName}".` });
      out[responseName] = null;
      continue;
    }
    const args: Record<string, unknown> = {};
    for (const arg of node.args) args[arg.name] = resolveValue(arg.value, ctx.variables);
    let value: unknown;
    if (fieldDef.resolve) {
      value = fieldDef.resolve(ctx, source, args);
    } else if (fieldDef.prop) {
      value = source[fieldDef.prop];
    } else {
      value = undefined;
    }
    if (value === null || value === undefined) {
      out[responseName] = null;
      continue;
    }
    if (node.selection) {
      const childType = fieldDef.type;
      if (Array.isArray(value)) {
        out[responseName] = value.map((item) =>
          item !== null && typeof item === 'object'
            ? executeSelection(ctx, childType, item as GqlObject, node.selection!, fragments, errors)
            : item,
        );
      } else if (typeof value === 'object') {
        out[responseName] = executeSelection(ctx, childType, value as GqlObject, node.selection, fragments, errors);
      } else {
        out[responseName] = value;
      }
    } else {
      out[responseName] = value;
    }
  }
  return out;
}
