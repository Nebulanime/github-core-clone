// GraphQL v4 at /api/graphql: a small parser for the query/mutation subset the
// suite sends, an executor over the same store as REST, __type introspection,
// batched operations (a JSON array body answers an array), and the 200-with-
// errors behaviour for unknown fields. Unknown repositories answer
// data.repository = null with no errors.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  Forge,
  VIEWER_USER,
  commentGlobalId,
  issueGlobalId,
  pullGlobalId,
  repoGlobalId,
  type Issue,
  type Pull,
  type Repo,
} from './store.ts';
import { parseJsonBody, sendError, sendJson } from './http.ts';

// ---------------------------------------------------------------------------
// Tokenizer.
// ---------------------------------------------------------------------------

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'spread'; value: '...' };

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === ';') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && input.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('{}():!=$@=[]|'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let value = '';
      i += 1;
      while (i < input.length) {
        const c = input[i] as string;
        if (c === '\\') {
          const next = input[i + 1] as string;
          value += next === 'n' ? '\n' : next === 't' ? '\t' : next === 'r' ? '\r' : next;
          i += 2;
          continue;
        }
        if (c === '"') {
          i += 1;
          break;
        }
        value += c;
        i += 1;
      }
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      let isFloat = false;
      if (input[j] === '-') j += 1;
      while (j < input.length && /[0-9]/.test(input[j] as string)) j += 1;
      if (input[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < input.length && /[0-9]/.test(input[j] as string)) j += 1;
      }
      if (input[j] === 'e' || input[j] === 'E') {
        isFloat = true;
        j += 1;
        if (input[j] === '+' || input[j] === '-') j += 1;
        while (j < input.length && /[0-9]/.test(input[j] as string)) j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: input.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < input.length && /[A-Za-z0-9_]/.test(input[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// Parser (the subset the suite sends: operations, variables, aliases, args,
// inline fragments, fragment spreads, directives are skipped).
// ---------------------------------------------------------------------------

export type GqlValue =
  | string
  | number
  | boolean
  | null
  | { variable: string }
  | { enum: string }
  | GqlValue[]
  | { [key: string]: GqlValue };

export interface GqlField {
  kind: 'field';
  name: string;
  alias: string | null;
  args: Record<string, GqlValue>;
  selections: GqlSelection[];
}

export interface GqlInlineFragment {
  kind: 'inline';
  typeCondition: string | null;
  selections: GqlSelection[];
}

export interface GqlSpread {
  kind: 'spread';
  name: string;
}

export type GqlSelection = GqlField | GqlInlineFragment | GqlSpread;

export interface GqlOperation {
  kind: 'query' | 'mutation' | 'subscription';
  name: string | null;
  variables: string[];
  selections: GqlSelection[];
}

export interface GqlDocument {
  operations: GqlOperation[];
  fragments: Map<string, GqlSelection[]>;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new Error('unexpected end of GraphQL document');
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${JSON.stringify(value)} in GraphQL document`);
  }

  private isPunct(value: string): boolean {
    const token = this.peek();
    return token !== undefined && token.kind === 'punct' && token.value === value;
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected a name in GraphQL document');
    return token.value;
  }

  parseDocument(): GqlDocument {
    const operations: GqlOperation[] = [];
    const fragments = new Map<string, GqlSelection[]>();
    while (this.pos < this.tokens.length) {
      const token = this.peek();
      if (token === undefined) break;
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ kind: 'query', name: null, variables: [], selections: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription')) {
        const kind = token.value as 'query' | 'mutation' | 'subscription';
        this.next();
        let name: string | null = null;
        const next = this.peek();
        if (next !== undefined && next.kind === 'name') name = this.next().value as string;
        const variables = this.parseVariableDefinitions();
        operations.push({ kind, name, variables, selections: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const name = this.expectName();
        this.expectName(); // 'on'
        this.expectName(); // the type condition
        fragments.set(name, this.parseSelectionSet());
        continue;
      }
      throw new Error(`unexpected token ${JSON.stringify(token)} in GraphQL document`);
    }
    return { operations, fragments };
  }

  private parseVariableDefinitions(): string[] {
    const variables: string[] = [];
    if (!this.isPunct('(')) return variables;
    this.next();
    while (!this.isPunct(')')) {
      this.expectPunct('$');
      variables.push(this.expectName());
      this.expectPunct(':');
      this.parseType();
      if (this.isPunct('=')) {
        this.next();
        this.parseValue();
      }
    }
    this.expectPunct(')');
    return variables;
  }

  private parseType(): void {
    if (this.isPunct('[')) {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    if (this.isPunct('!')) this.next();
  }

  private parseSelectionSet(): GqlSelection[] {
    this.expectPunct('{');
    const selections: GqlSelection[] = [];
    while (!this.isPunct('}')) {
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): GqlSelection {
    const token = this.peek();
    if (token !== undefined && token.kind === 'spread') {
      this.next();
      const next = this.peek();
      if (next !== undefined && next.kind === 'name' && next.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        this.skipDirectives();
        return { kind: 'inline', typeCondition, selections: this.parseSelectionSet() };
      }
      if (next !== undefined && next.kind === 'name') {
        const name = this.next().value as string;
        this.skipDirectives();
        return { kind: 'spread', name };
      }
      this.skipDirectives();
      return { kind: 'inline', typeCondition: null, selections: this.parseSelectionSet() };
    }
    // A field: [alias:] name[(args)] [directives] [selection set].
    let name = this.expectName();
    let alias: string | null = null;
    if (this.isPunct(':')) {
      this.next();
      alias = name;
      name = this.expectName();
    }
    const args = this.parseArguments();
    this.skipDirectives();
    const selections = this.isPunct('{') ? this.parseSelectionSet() : [];
    return { kind: 'field', name, alias, args, selections };
  }

  private parseArguments(): Record<string, GqlValue> {
    const args: Record<string, GqlValue> = {};
    if (!this.isPunct('(')) return args;
    this.next();
    while (!this.isPunct(')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args[name] = this.parseValue();
    }
    this.expectPunct(')');
    return args;
  }

  private parseValue(): GqlValue {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { variable: this.expectName() };
    if (token.kind === 'punct' && token.value === '[') {
      const items: GqlValue[] = [];
      while (!this.isPunct(']')) items.push(this.parseValue());
      this.expectPunct(']');
      return items;
    }
    if (token.kind === 'punct' && token.value === '{') {
      const object: { [key: string]: GqlValue } = {};
      while (!this.isPunct('}')) {
        const name = this.expectName();
        this.expectPunct(':');
        object[name] = this.parseValue();
      }
      this.expectPunct('}');
      return object;
    }
    if (token.kind === 'string') return token.value;
    if (token.kind === 'int') return Number(token.value);
    if (token.kind === 'float') return Number(token.value);
    if (token.kind === 'name') {
      if (token.value === 'true') return true;
      if (token.value === 'false') return false;
      if (token.value === 'null') return null;
      return { enum: token.value };
    }
    throw new Error(`unexpected value token ${JSON.stringify(token)}`);
  }

  private skipDirectives(): void {
    while (this.isPunct('@')) {
      this.next();
      this.expectName();
      this.parseArguments();
    }
  }
}

export function parseGraphQL(input: string): GqlDocument {
  return new Parser(tokenize(input)).parseDocument();
}

// ---------------------------------------------------------------------------
// Schema (field sets for unknown-field errors and for __type introspection).
// ---------------------------------------------------------------------------

const FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['id', 'login', 'name', 'email'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'description', 'isPrivate',
    'createdAt', 'updatedAt',
  ],
  Issue: ['id', 'number', 'title', 'body', 'state', 'author', 'createdAt', 'updatedAt', 'labels', 'comments', 'url'],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName',
    'headRefOid', 'baseRefOid', 'files', 'author', 'createdAt', 'updatedAt', 'url',
  ],
  Ref: ['id', 'name'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  FileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueEdge: ['node', 'cursor'],
  PullRequestEdge: ['node', 'cursor'],
  FileEdge: ['node', 'cursor'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  File: ['path', 'additions', 'deletions', 'changes', 'status'],
  Label: ['id', 'name', 'color', 'description'],
  Comment: ['id', 'body', 'author'],
  CommentEdge: ['node', 'cursor'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'comment', 'subject', 'clientMutationId'],
  __Type: ['name', 'kind', 'description', 'fields', 'enumValues', 'inputFields', 'interfaces', 'possibleTypes'],
  __Field: ['name', 'description', 'args', 'type'],
  __EnumValue: ['name', 'description'],
  __InputValue: ['name', 'description', 'type', 'defaultValue'],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION'],
};

// ---------------------------------------------------------------------------
// Values: every GraphQL object is { __typename, ...raw }.
// ---------------------------------------------------------------------------

type GqlObject = Record<string, unknown> & { __typename: string };

function userObject(): GqlObject {
  return { __typename: 'User', login: VIEWER_USER.login, id: VIEWER_USER.id, name: VIEWER_USER.name, email: VIEWER_USER.email };
}

function repoObject(repo: Repo): GqlObject {
  return { __typename: 'Repository', repo };
}

function issueObject(repo: Repo, issue: Issue): GqlObject {
  return { __typename: 'Issue', repo, issue };
}

function pullObject(repo: Repo, pull: Pull): GqlObject {
  return { __typename: 'PullRequest', repo, pull };
}

// ---------------------------------------------------------------------------
// Executor.
// ---------------------------------------------------------------------------

interface ExecContext {
  forge: Forge;
  variables: Record<string, unknown>;
  errors: Array<{ message: string }>;
  fragments: Map<string, GqlSelection[]>;
}

function resolveValue(value: GqlValue, variables: Record<string, unknown>): unknown {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    if ('variable' in value) return variables[(value as { variable: string }).variable] ?? null;
    if ('enum' in value) return (value as { enum: string }).enum;
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) out[key] = resolveValue(child as GqlValue, variables);
    return out;
  }
  if (Array.isArray(value)) return value.map((child) => resolveValue(child, variables));
  return value;
}

function argsOf(field: GqlField, ctx: ExecContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(field.args)) out[key] = resolveValue(value, ctx.variables);
  return out;
}

function encodeCursor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function decodeCursor(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    if (!text.startsWith('cursor:')) return null;
    const n = Number(text.slice('cursor:'.length));
    return Number.isInteger(n) ? n : null;
  } catch {
    return null;
  }
}

interface DecodedId {
  kind: string;
  key: string;
}

function decodeGlobalId(id: unknown): DecodedId | null {
  if (typeof id !== 'string' || id === '') return null;
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon < 0) return null;
    return { kind: text.slice(0, colon), key: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

function findRepoById(forge: Forge, id: unknown): Repo | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'R') return null;
  const slash = decoded.key.indexOf('/');
  if (slash < 0) return null;
  return forge.getRepo(decoded.key.slice(0, slash), decoded.key.slice(slash + 1)) ?? null;
}

function findIssueById(forge: Forge, id: unknown): { repo: Repo; issue: Issue } | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'I') return null;
  const parts = decoded.key.split('/');
  if (parts.length !== 3) return null;
  const repo = forge.getRepo(parts[0] as string, parts[1] as string);
  if (repo === undefined) return null;
  const issue = forge.findIssue(repo, Number(parts[2]));
  return issue === undefined ? null : { repo, issue };
}

function findPullById(forge: Forge, id: unknown): { repo: Repo; pull: Pull } | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'PR') return null;
  const parts = decoded.key.split('/');
  if (parts.length !== 3) return null;
  const repo = forge.getRepo(parts[0] as string, parts[1] as string);
  if (repo === undefined) return null;
  const pull = forge.findPull(repo, Number(parts[2]));
  return pull === undefined ? null : { repo, pull };
}

function issueState(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullState(pull: Pull): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

/** The issue connection for a repository (states filter, CREATED_AT order, cursor). */
function issueConnection(repo: Repo, args: Record<string, unknown>): GqlObject {
  let issues = [...repo.issues];
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((state) => String(state)));
    issues = issues.filter((issue) => wanted.has(issueState(issue)));
  }
  const orderBy = args.orderBy as Record<string, unknown> | undefined;
  if (orderBy !== undefined && orderBy.field === 'CREATED_AT') {
    issues.sort((a, b) => (orderBy.direction === 'ASC' ? a.number - b.number : b.number - a.number));
  } else {
    issues.sort((a, b) => a.number - b.number);
  }
  const after = decodeCursor(args.after);
  if (after !== null) issues = issues.filter((issue) => issue.number > after);
  const first = typeof args.first === 'number' ? args.first : issues.length;
  const page = issues.slice(0, first);
  const hasNextPage = issues.length > page.length;
  const endCursor = page.length > 0 ? encodeCursor((page[page.length - 1] as Issue).number) : null;
  return {
    __typename: 'IssueConnection',
    nodes: page.map((issue) => issueObject(repo, issue)),
    edges: page.map((issue) => ({ __typename: 'IssueEdge', node: issueObject(repo, issue), cursor: encodeCursor(issue.number) })),
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage,
      hasPreviousPage: after !== null,
      startCursor: page.length > 0 ? encodeCursor((page[0] as Issue).number) : null,
      endCursor,
    },
    totalCount: repo.issues.length,
  };
}

function pullConnection(repo: Repo, args: Record<string, unknown>): GqlObject {
  let pulls = [...repo.pulls];
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((state) => String(state)));
    pulls = pulls.filter((pull) => wanted.has(pullState(pull)));
  }
  pulls.sort((a, b) => b.number - a.number);
  const after = decodeCursor(args.after);
  if (after !== null) pulls = pulls.filter((pull) => pull.number < after);
  const first = typeof args.first === 'number' ? args.first : pulls.length;
  const page = pulls.slice(0, first);
  const hasNextPage = pulls.length > page.length;
  return {
    __typename: 'PullRequestConnection',
    nodes: page.map((pull) => pullObject(repo, pull)),
    edges: page.map((pull) => ({ __typename: 'PullRequestEdge', node: pullObject(repo, pull), cursor: encodeCursor(pull.number) })),
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage,
      hasPreviousPage: after !== null,
      startCursor: page.length > 0 ? encodeCursor((page[0] as Pull).number) : null,
      endCursor: page.length > 0 ? encodeCursor((page[page.length - 1] as Pull).number) : null,
    },
    totalCount: repo.pulls.length,
  };
}

/** Resolve one field of a parent object. Returns undefined for "no such field" handling by the caller. */
function resolveField(parent: GqlObject, field: GqlField, args: Record<string, unknown>, ctx: ExecContext): unknown {
  const type = parent.__typename;
  const name = field.name;

  if (type === 'Query') {
    if (name === 'viewer') return userObject();
    if (name === 'repository') {
      const repo = ctx.forge.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
      return repo === undefined ? null : repoObject(repo);
    }
    if (name === 'node') {
      const decoded = decodeGlobalId(args.id);
      if (decoded === null) return null;
      if (decoded.kind === 'R') {
        const repo = findRepoById(ctx.forge, args.id);
        return repo === null ? null : repoObject(repo);
      }
      if (decoded.kind === 'I') {
        const found = findIssueById(ctx.forge, args.id);
        return found === null ? null : issueObject(found.repo, found.issue);
      }
      if (decoded.kind === 'PR') {
        const found = findPullById(ctx.forge, args.id);
        return found === null ? null : pullObject(found.repo, found.pull);
      }
      return null;
    }
    if (name === '__type') {
      const typeName = String(args.name ?? '');
      const fields = FIELDS[typeName];
      if (fields === undefined && ENUM_VALUES[typeName] === undefined) return null;
      return {
        __typename: '__Type',
        name: typeName,
        kind: ENUM_VALUES[typeName] !== undefined ? 'ENUM' : 'OBJECT',
        fields: fields === undefined ? null : fields.map((fieldName) => ({ __typename: '__Field', name: fieldName })),
        enumValues:
          ENUM_VALUES[typeName] === undefined
            ? null
            : (ENUM_VALUES[typeName] as string[]).map((value) => ({ __typename: '__EnumValue', name: value })),
      };
    }
    if (name === '__schema') {
      return { __typename: '__Schema', types: Object.keys(FIELDS).map((typeName) => ({ __typename: '__Type', name: typeName })) };
    }
    return undefined;
  }

  if (type === 'Mutation') {
    if (name === 'createIssue') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = findRepoById(ctx.forge, input.repositoryId);
      if (repo === null) return null;
      const created = ctx.forge.createIssue(repo, String(input.title ?? ''), String(input.body ?? ''), []);
      if ('error' in created) return null;
      return { __typename: 'CreateIssuePayload', issue: issueObject(repo, created) };
    }
    if (name === 'closeIssue') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = findIssueById(ctx.forge, input.issueId);
      if (found === null) return null;
      found.issue.state = 'closed';
      return { __typename: 'CloseIssuePayload', issue: issueObject(found.repo, found.issue) };
    }
    if (name === 'createPullRequest') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = findRepoById(ctx.forge, input.repositoryId);
      if (repo === null) return null;
      const created = ctx.forge.createPull(
        repo,
        String(input.title ?? ''),
        String(input.body ?? ''),
        String(input.headRefName ?? ''),
        String(input.baseRefName ?? ''),
      );
      if ('error' in created) return null;
      return { __typename: 'CreatePullRequestPayload', pullRequest: pullObject(repo, created) };
    }
    if (name === 'mergePullRequest') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = findPullById(ctx.forge, input.pullRequestId);
      if (found === null) return null;
      const result = ctx.forge.mergePull(found.repo, found.pull);
      if (result.status !== 200) return { __typename: 'MergePullRequestPayload', pullRequest: pullObject(found.repo, found.pull) };
      return { __typename: 'MergePullRequestPayload', pullRequest: pullObject(found.repo, found.pull) };
    }
    if (name === 'addComment') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = findIssueById(ctx.forge, input.subjectId);
      if (found === null) return null;
      const comment = { id: found.repo.nextCommentId, body: String(input.body ?? '') };
      found.repo.nextCommentId += 1;
      found.issue.comments.push(comment);
      const node: GqlObject = {
        __typename: 'Comment',
        id: commentGlobalId(found.repo.owner, found.repo.name, found.issue.number, comment.id),
        body: comment.body,
      };
      return {
        __typename: 'AddCommentPayload',
        commentEdge: { __typename: 'CommentEdge', node, cursor: encodeCursor(comment.id) },
        comment: node,
      };
    }
    return undefined;
  }

  if (type === 'User') {
    if (name === 'id') return parent.id ?? '';
    if (name === 'login') return parent.login ?? '';
    if (name === 'name') return parent.name ?? '';
    if (name === 'email') return parent.email ?? '';
    return undefined;
  }

  if (type === 'Repository') {
    const repo = parent.repo as Repo;
    if (name === 'id') return repoGlobalId(repo.owner, repo.name);
    if (name === 'databaseId') return repo.dbId;
    if (name === 'name') return repo.name;
    if (name === 'nameWithOwner') return `${repo.owner}/${repo.name}`;
    if (name === 'owner') return userObject();
    if (name === 'defaultBranchRef') {
      const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      if (tip === undefined) return null;
      return { __typename: 'Ref', name: repo.defaultBranch };
    }
    if (name === 'viewerPermission') return 'ADMIN';
    if (name === 'hasIssuesEnabled') return true;
    if (name === 'description') return repo.description;
    if (name === 'isPrivate') return repo.isPrivate;
    if (name === 'issue') {
      const issue = ctx.forge.findIssue(repo, Number(args.number));
      return issue === undefined ? null : issueObject(repo, issue);
    }
    if (name === 'issues') return issueConnection(repo, args);
    if (name === 'pullRequest') {
      const pull = ctx.forge.findPull(repo, Number(args.number));
      return pull === undefined ? null : pullObject(repo, pull);
    }
    if (name === 'pullRequests') return pullConnection(repo, args);
    return undefined;
  }

  if (type === 'Issue') {
    const issue = parent.issue as Issue;
    const repo = parent.repo as Repo;
    if (name === 'id') return issueGlobalId(repo.owner, repo.name, issue.number);
    if (name === 'number') return issue.number;
    if (name === 'title') return issue.title;
    if (name === 'body') return issue.body;
    if (name === 'state') return issueState(issue);
    if (name === 'author') return userObject();
    if (name === 'labels') return { __typename: 'LabelConnection', nodes: issue.labels.map((labelName) => ({ __typename: 'Label', name: labelName })) };
    if (name === 'comments') return { __typename: 'CommentConnection', nodes: issue.comments.map((comment) => ({ __typename: 'Comment', id: commentGlobalId(repo.owner, repo.name, issue.number, comment.id), body: comment.body })) };
    if (name === 'url') return '';
    return undefined;
  }

  if (type === 'PullRequest') {
    const pull = parent.pull as Pull;
    const repo = parent.repo as Repo;
    if (name === 'id') return pullGlobalId(repo.owner, repo.name, pull.number);
    if (name === 'number') return pull.number;
    if (name === 'title') return pull.title;
    if (name === 'body') return pull.body;
    if (name === 'state') return pullState(pull);
    if (name === 'merged') return pull.merged;
    if (name === 'mergeable') {
      if (pull.state !== 'open') return 'UNKNOWN';
      return ctx.forge.pullConflicts(repo, pull) ? 'CONFLICTING' : 'MERGEABLE';
    }
    if (name === 'headRefName') return pull.headRef;
    if (name === 'baseRefName') return pull.baseRef;
    if (name === 'headRefOid') return pull.headSha;
    if (name === 'baseRefOid') return pull.baseSha;
    if (name === 'author') return userObject();
    if (name === 'files') {
      const files = pull.files;
      const first = typeof args.first === 'number' ? args.first : files.length;
      const page = files.slice(0, first);
      return {
        __typename: 'FileConnection',
        nodes: page.map((file) => ({ __typename: 'File', path: file.filename, additions: file.additions, deletions: file.deletions, changes: file.changes, status: file.status.toUpperCase() })),
        edges: page.map((file) => ({ __typename: 'FileEdge', node: { __typename: 'File', path: file.filename }, cursor: '' })),
        pageInfo: { __typename: 'PageInfo', hasNextPage: files.length > page.length, hasPreviousPage: false, startCursor: null, endCursor: null },
        totalCount: files.length,
      };
    }
    if (name === 'url') return '';
    return undefined;
  }

  if (type === 'Ref') {
    if (name === 'name') return parent.name ?? '';
    if (name === 'id') return '';
    return undefined;
  }

  if (type === 'PageInfo') {
    if (name === 'hasNextPage') return parent.hasNextPage ?? false;
    if (name === 'hasPreviousPage') return parent.hasPreviousPage ?? false;
    if (name === 'startCursor') return parent.startCursor ?? null;
    if (name === 'endCursor') return parent.endCursor ?? null;
    return undefined;
  }

  // Connections, edges, payloads, introspection types: plain property reads.
  if (
    type === 'IssueConnection' || type === 'PullRequestConnection' || type === 'FileConnection' ||
    type === 'LabelConnection' || type === 'CommentConnection'
  ) {
    if (name === 'nodes' || name === 'edges' || name === 'pageInfo' || name === 'totalCount') return parent[name] ?? null;
    return undefined;
  }
  if (type === 'IssueEdge' || type === 'PullRequestEdge' || type === 'FileEdge' || type === 'CommentEdge') {
    if (name === 'node' || name === 'cursor') return parent[name] ?? null;
    return undefined;
  }
  if (
    type === 'CreateIssuePayload' || type === 'CloseIssuePayload' ||
    type === 'CreatePullRequestPayload' || type === 'MergePullRequestPayload' || type === 'AddCommentPayload'
  ) {
    if (name === 'issue' || name === 'pullRequest' || name === 'commentEdge' || name === 'comment' || name === 'subject' || name === 'clientMutationId') {
      return parent[name] ?? null;
    }
    return undefined;
  }
  if (type === '__Type') {
    if (name === 'name' || name === 'kind' || name === 'description') return parent[name] ?? null;
    if (name === 'fields') return parent.fields ?? null;
    if (name === 'enumValues') return parent.enumValues ?? null;
    if (name === 'inputFields' || name === 'interfaces' || name === 'possibleTypes') return null;
    return undefined;
  }
  if (type === '__Field' || type === '__EnumValue' || type === '__InputValue') {
    if (name === 'name' || name === 'description' || name === 'args' || name === 'type' || name === 'defaultValue') {
      return parent[name] ?? null;
    }
    return undefined;
  }
  if (type === 'File' || type === 'Label' || type === 'Comment') {
    if (name in parent) return parent[name] as unknown;
    return undefined;
  }

  return undefined;
}

/** Execute a selection set against a parent object; unknown fields become errors + null. */
function executeSelections(parent: GqlObject, selections: readonly GqlSelection[], ctx: ExecContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'inline') {
      if (selection.typeCondition !== null && selection.typeCondition !== parent.__typename) continue;
      Object.assign(out, executeSelections(parent, selection.selections, ctx));
      continue;
    }
    if (selection.kind === 'spread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment !== undefined) Object.assign(out, executeSelections(parent, fragment, ctx));
      continue;
    }
    const field = selection;
    const responseKey = field.alias ?? field.name;
    const known = (FIELDS[parent.__typename] ?? []).includes(field.name);
    if (!known) {
      ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${parent.__typename}".` });
      out[responseKey] = null;
      continue;
    }
    const args = argsOf(field, ctx);
    const value = resolveField(parent, field, args, ctx);
    if (value === undefined) {
      ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${parent.__typename}".` });
      out[responseKey] = null;
      continue;
    }
    out[responseKey] = executeValue(value, field.selections, ctx);
  }
  return out;
}

function executeValue(value: unknown, selections: readonly GqlSelection[], ctx: ExecContext): unknown {
  if (value === null || value === undefined) return null;
  if (selections.length === 0) return value;
  if (Array.isArray(value)) return value.map((item) => executeValue(item, selections, ctx));
  if (typeof value === 'object') {
    const object = value as GqlObject;
    if (object.__typename === undefined) return value;
    return executeSelections(object, selections, ctx);
  }
  return value;
}

function executeOperation(forge: Forge, operation: GqlOperation, fragments: Map<string, GqlSelection[]>, variables: Record<string, unknown>): { data: Record<string, unknown>; errors?: Array<{ message: string }> } {
  const ctx: ExecContext = { forge, variables, errors: [], fragments };
  const rootType = operation.kind === 'mutation' ? 'Mutation' : 'Query';
  const root: GqlObject = { __typename: rootType };
  const data = executeSelections(root, operation.selections, ctx);
  if (ctx.errors.length > 0) return { data, errors: ctx.errors };
  return { data };
}

// ---------------------------------------------------------------------------
// HTTP handler.
// ---------------------------------------------------------------------------

export function handleGraphQL(forge: Forge, req: IncomingMessage, res: ServerResponse, body: Buffer): void {
  const parsed = parseJsonBody(body);
  if (!parsed.ok) {
    sendJson(res, 400, { errors: [{ message: `the request body is not valid JSON: ${parsed.error}` }] });
    return;
  }
  const value = parsed.value;
  try {
    if (Array.isArray(value)) {
      const results = value.map((entry) => runOne(forge, entry));
      sendJson(res, 200, results);
      return;
    }
    sendJson(res, 200, runOne(forge, value));
  } catch (err) {
    sendError(res, 400, err instanceof Error ? err.message : 'GraphQL request failed');
  }
}

function runOne(forge: Forge, entry: unknown): { data: Record<string, unknown> | null; errors?: Array<{ message: string }> } {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    return { data: null, errors: [{ message: 'the request body must be a GraphQL operation object' }] };
  }
  const operation = entry as { query?: unknown; variables?: unknown; operationName?: unknown };
  if (typeof operation.query !== 'string') {
    return { data: null, errors: [{ message: 'the request carries no query string' }] };
  }
  let document: GqlDocument;
  try {
    document = parseGraphQL(operation.query);
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'the query does not parse' }] };
  }
  if (document.operations.length === 0) {
    return { data: null, errors: [{ message: 'the document holds no operation' }] };
  }
  const variables =
    typeof operation.variables === 'object' && operation.variables !== null
      ? (operation.variables as Record<string, unknown>)
      : {};
  let selected = document.operations[0] as GqlOperation;
  if (typeof operation.operationName === 'string') {
    const named = document.operations.find((candidate) => candidate.name === operation.operationName);
    if (named !== undefined) selected = named;
  }
  return executeOperation(forge, selected, document.fragments, variables);
}
