// GitHub GraphQL v4: a small document parser and a resolver over the store, for
// the queries and mutations gh and github-mcp-server send.
import type { Ctx } from './rest.ts';
import { branchDiff, createIssue, createPull, mergePull } from './rest.ts';
import type { Issue, Pull, Repo, Store } from './store.ts';

interface Field {
  alias: string;
  name: string;
  args: Record<string, unknown>;
  selections: Field[];
  fragments: string[];
  inline: boolean;
  typeName?: string;
}

interface Document { operations: Field[][]; fragments: Map<string, Field[]> }

const PUNCT = new Set(['{', '}', '(', ')', '[', ']', ':', ',', '!', '$', '=', '@', '|', '&']);

function lex(src: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '#') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') { i++; continue; }
    if (c === '.' && src[i + 1] === '.' && src[i + 2] === '.') { out.push('...'); i += 3; continue; }
    if (PUNCT.has(c)) { out.push(c); i++; continue; }
    if (c === '"') {
      if (src[i + 1] === '"' && src[i + 2] === '"') {
        const end = src.indexOf('"""', i + 3);
        out.push(JSON.stringify(src.slice(i + 3, end === -1 ? src.length : end)));
        i = end === -1 ? src.length : end + 3;
        continue;
      }
      let j = i + 1;
      while (j < src.length && src[j] !== '"') { if (src[j] === '\\') j++; j++; }
      out.push(src.slice(i, j + 1));
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i + 1;
      while (j < src.length && /[0-9.eE+-]/.test(src[j])) j++;
      out.push(src.slice(i, j));
      i = j;
      continue;
    }
    let j = i;
    while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
    if (j === i) { i++; continue; }
    out.push(src.slice(i, j));
    i = j;
  }
  return out;
}

function parseDocument(src: string, variables: Record<string, unknown>): Document {
  const tokens = lex(src);
  let p = 0;
  const fragments = new Map<string, Field[]>();

  const parseValue = (): unknown => {
    const t = tokens[p];
    if (t === '$') { p++; const name = tokens[p++]; return variables[name]; }
    if (t === '{') {
      p++;
      const obj: Record<string, unknown> = {};
      while (tokens[p] !== '}' && p < tokens.length) {
        const key = tokens[p++];
        if (tokens[p] === ':') p++;
        obj[key] = parseValue();
      }
      p++;
      return obj;
    }
    if (t === '[') {
      p++;
      const arr: unknown[] = [];
      while (tokens[p] !== ']' && p < tokens.length) arr.push(parseValue());
      p++;
      return arr;
    }
    p++;
    if (t === undefined) return null;
    if (t.startsWith('"')) return JSON.parse(t);
    if (t === 'true') return true;
    if (t === 'false') return false;
    if (t === 'null') return null;
    if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(t)) return Number(t);
    return t;
  };

  const parseSelectionSet = (): Field[] => {
    const fields: Field[] = [];
    if (tokens[p] === '{') p++;
    while (p < tokens.length && tokens[p] !== '}') {
      if (tokens[p] === '...') {
        p++;
        if (tokens[p] === 'on') {
          p += 1;
          const typeName = tokens[p] ?? '';
          p += 1;
          const selections = parseSelectionSet();
          fields.push({ alias: '...', name: '...', args: {}, selections, fragments: [], inline: true, typeName });
        } else {
          const name = tokens[p++];
          fields.push({ alias: '...', name, args: {}, selections: [], fragments: [name], inline: false });
        }
        continue;
      }
      const first = tokens[p++];
      let name = first;
      let alias = first;
      if (tokens[p] === ':') { p++; name = tokens[p++]; } else alias = name;
      const args: Record<string, unknown> = {};
      if (tokens[p] === '(') {
        p++;
        while (tokens[p] !== ')' && p < tokens.length) {
          const argName = tokens[p++];
          if (tokens[p] === ':') p++;
          args[argName] = parseValue();
        }
        if (tokens[p] === ')') p++;
      }
      let selections: Field[] = [];
      if (tokens[p] === '{') selections = parseSelectionSet();
      fields.push({ alias, name, args, selections, fragments: [], inline: false });
    }
    if (tokens[p] === '}') p++;
    return fields;
  };

  const operations: Field[][] = [];
  while (p < tokens.length) {
    const t = tokens[p];
    if (t === 'fragment') {
      p++;
      const name = tokens[p++];
      if (tokens[p] === 'on') p += 2;
      fragments.set(name, parseSelectionSet());
      continue;
    }
    if (t === 'query' || t === 'mutation' || t === 'subscription') {
      p++;
      if (tokens[p] && /^[A-Za-z_]/.test(tokens[p]) && tokens[p] !== 'on') p++;
      if (tokens[p] === '(') {
        let depth = 0;
        while (p < tokens.length) {
          const tok = tokens[p];
          if (tok === '(') depth++;
          else if (tok === ')') { depth--; p++; if (depth === 0) break; continue; }
          p++;
        }
      }
      if (tokens[p] === '@') { while (p < tokens.length && tokens[p] !== '{') p++; }
      operations.push(parseSelectionSet());
      continue;
    }
    if (t === '{') { operations.push(parseSelectionSet()); continue; }
    p++;
  }
  return { operations, fragments };
}

type Kind = 'Query' | 'Repository' | 'Issue' | 'PullRequest' | 'User' | 'Ref' | 'Connection' | 'Label' | 'File' | 'Payload' | 'Comment' | 'PageInfo' | 'Edge';

interface ResolveEnv {
  store: Store;
  ctx: Ctx;
  fragments: Map<string, Field[]>;
  errors: { message: string; path?: (string | number)[] }[];
}

function resolveFields(kind: Kind, value: unknown, fields: Field[], env: ResolveEnv,
  path: (string | number)[] = []): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const run = (list: Field[], current: Kind): void => {
    for (const f of list) {
      if (f.inline) { run(f.selections, (f.typeName as Kind) ?? current); continue; }
      if (f.name === '...' && f.fragments.length) {
        for (const name of f.fragments) {
          const frag = env.fragments.get(name);
          if (frag) run(frag, current);
        }
        continue;
      }
      if (f.name === '__typename') { out[f.alias] = current === 'Query' ? 'Query' : current; continue; }
      const res = resolveOne(current, value, f, env, [...path, f.alias]);
      if (res === UNKNOWN) {
        env.errors.push({ message: `Field "${f.name}" doesn't exist on type "${current}"`, path: [...path, f.alias] });
        continue;
      }
      if (res instanceof PreProjected) {
        out[f.alias] = res.value;
        continue;
      }
      out[f.alias] = res !== null && f.selections.length && !f.name.startsWith('__')
        ? projectChild(current, res, f, env, [...path, f.alias])
        : res;
    }
  };
  run(fields, kind);
  return out;
}

/** A value the resolver already projected, so the generic pass leaves it alone. */
class PreProjected {
  value: unknown;

  constructor(value: unknown) {
    this.value = value;
  }
}

const UNKNOWN = Symbol('unknown');

function childKind(kind: Kind, name: string): Kind | null {
  const map: Record<string, Record<string, Kind>> = {
    Query: { repository: 'Repository', viewer: 'User', createPullRequest: 'Payload', createIssue: 'Payload',
      closeIssue: 'Payload', addComment: 'Payload', mergePullRequest: 'Payload' },
    Payload: { issue: 'Issue', pullRequest: 'PullRequest', issueComment: 'Comment' },
    Comment: {},
    Repository: {
      owner: 'User', defaultBranchRef: 'Ref', issue: 'Issue', issues: 'Connection',
      pullRequests: 'Connection', pullRequest: 'PullRequest',
    },
    PullRequest: { files: 'Connection' },
    Issue: { comments: 'Connection' },
    Connection: { nodes: 'Issue', pageInfo: 'PageInfo', edges: 'Edge' },
    Edge: { node: 'Issue' },
  };
  return map[kind]?.[name] ?? null;
}

function projectChild(kind: Kind, value: unknown, f: Field, env: ResolveEnv,
  path: (string | number)[]): unknown {
  if (f.selections.length === 0) return value;
  if (kind === 'Query' && f.name === 'node' && value && typeof value === 'object') {
    const rec = value as Record<string, unknown>;
    const nodeKind: Kind = 'head' in rec || 'merged' in rec ? 'PullRequest'
      : 'owner' in rec ? 'Repository' : 'Issue';
    return resolveFields(nodeKind, value, f.selections, env, path);
  }
  if (Array.isArray(value)) {
    const ck = childKind(kind, f.name) ?? kind;
    return value.map((v, i) => (v && typeof v === 'object'
      ? resolveFields(ck, v, f.selections, env, [...path, i])
      : v));
  }
  const ck = childKind(kind, f.name) ?? kind;
  return value && typeof value === 'object'
    ? resolveFields(ck, value, f.selections, env, path)
    : value;
}

function resolveOne(kind: Kind, value: unknown, f: Field, env: ResolveEnv,
  path: (string | number)[]): unknown {
  const store = env.store;
  const ctx = env.ctx;
  if (kind === 'Query') {
    if (f.name === '__type') return typeIntrospection(String(f.args.name ?? ''));
    if (f.name === '__schema') return { queryType: { name: 'Query' }, mutationType: { name: 'Mutation' } };
    if (f.name === 'rateLimit') return { limit: 5000, remaining: 4999, resetAt: store.now(), cost: 1 };
    if (f.name === 'viewer') return { login: ctx.user!.login, id: `U_${ctx.user!.login}`, databaseId: ctx.user!.id };
    if (f.name === 'repository') {
      const repo = store.repo(String(f.args.owner ?? ''), String(f.args.name ?? ''));
      return repo ?? null;
    }
    if (f.name === 'createPullRequest') {
      const input = (f.args.input ?? {}) as Record<string, unknown>;
      const repo = repoByNodeId(store, String(input.repositoryId ?? ''));
      if (!repo) {
        env.errors.push({ message: 'Could not resolve to a Repository with the global id', path });
        return null;
      }
      const pull = createPull(store, repo, String(input.title ?? ''), String(input.headRefName ?? ''),
        String(input.baseRefName ?? ''), ctx.user!.login, String(input.body ?? ''));
      return { pullRequest: pull };
    }
    if (f.name === 'mergePullRequest') {
      const input = (f.args.input ?? {}) as Record<string, unknown>;
      const pull = findPullByNodeId(store, String(input.pullRequestId ?? ''));
      if (!pull) {
        env.errors.push({ message: 'Could not resolve to a PullRequest with the global id', path });
        return null;
      }
      const repo = repoOfPull(store, pull);
      if (!repo) return null;
      const method = String(input.mergeMethod ?? 'MERGE').toLowerCase();
      const result = mergePull(ctx, repo, pull, method === 'squash' ? 'squash' : 'merge');
      if (result.status !== 200) {
        env.errors.push({ message: 'Pull request is not mergeable', path });
        return { pullRequest: pull };
      }
      return { pullRequest: pull };
    }
    if (f.name === 'closeIssue') {
      const input = (f.args.input ?? {}) as Record<string, unknown>;
      const issue = findIssueByNodeId(store, String(input.issueId ?? ''));
      if (!issue) {
        env.errors.push({ message: 'Could not resolve to an Issue with the global id', path });
        return null;
      }
      issue.state = 'closed';
      issue.closedAt = store.now();
      issue.updatedAt = store.now();
      return { issue };
    }
    if (f.name === 'addComment') {
      const input = (f.args.input ?? {}) as Record<string, unknown>;
      const issue = findIssueByNodeId(store, String(input.subjectId ?? ''));
      if (!issue) {
        env.errors.push({ message: 'Could not resolve to an Issue with the global id', path });
        return null;
      }
      const comment = { id: store.nextId(), body: String(input.body ?? ''), user: ctx.user!.login, createdAt: store.now() };
      issue.comments.push(comment);
      issue.updatedAt = store.now();
      return { issueComment: { id: `IC_${comment.id}`, body: comment.body, createdAt: comment.createdAt, author: { login: comment.user } },
        commentEdge: { cursor: `cursor-${comment.id}`, node: { id: `IC_${comment.id}`, body: comment.body, author: { login: comment.user }, createdAt: comment.createdAt } } };
    }
    if (f.name === 'node') {
      const id = String(f.args.id ?? '');
      const repoNode = repoByNodeId(store, id);
      if (repoNode) return repoNode;
      const issue = findIssueByNodeId(store, id);
      if (issue) return issue;
      const pull = findPullByNodeId(store, id);
      if (pull) return pull;
      return null;
    }
    if (f.name === 'createIssue') {
      const input = (f.args.input ?? {}) as Record<string, unknown>;
      const repo = repoByNodeId(store, String(input.repositoryId ?? ''));
      if (!repo) {
        env.errors.push({ message: 'Could not resolve to a Repository with the global id', path });
        return null;
      }
      const issue = createIssue(store, repo, String(input.title ?? ''), String(input.body ?? ''),
        ctx.user!.login);
      return { issue };
    }
    return UNKNOWN;
  }

  if (kind === 'Repository') {
    const repo = value as Repo;
    switch (f.name) {
      case 'id': return `R_${repo.id}`;
      case 'databaseId': return repo.id;
      case 'name': return repo.name;
      case 'nameWithOwner': return `${repo.owner}/${repo.name}`;
      case 'description': return repo.description;
      case 'isPrivate': return repo.private;
      case 'url': return `${ctx.base}/${repo.owner}/${repo.name}`;
      case 'owner': return { login: repo.owner, id: 1, resourcePath: `/${repo.owner}` };
      case 'viewerPermission': return 'ADMIN';
      case 'hasIssuesEnabled': return repo.hasIssues;
      case 'defaultBranchRef': {
        const sha = store.headSha(repo);
        return sha ? { name: repo.defaultBranch, target: { oid: sha } } : null;
      }
      case 'issue':
      case 'pullRequest': {
        const num = Number(f.args.number ?? 0);
        if (f.name === 'issue') {
          const issue = store.issueList(repo.id).find((i) => i.number === num && !i.isPull);
          return issue ?? null;
        }
        const pull = store.pullList(repo.id).find((p) => p.number === num);
        if (!pull) return null;
        const full = pullWithFiles(store, repo, pull);
        return full;
      }
      case 'issues':
      case 'pullRequests': {
        const list = f.name === 'issues'
          ? store.issueList(repo.id).filter((i) => !i.isPull)
          : store.pullList(repo.id);
        const states = Array.isArray(f.args.states)
          ? (f.args.states as unknown[]).map((s) => String(s).toUpperCase())
          : ['OPEN'];
        const orderBy = (f.args.orderBy ?? {}) as Record<string, unknown>;
        const desc = String(orderBy.direction ?? 'DESC').toUpperCase() !== 'ASC';
        let filtered = list as (Issue | Pull)[];
        if (states.length) {
          filtered = filtered.filter((i) => {
            const st = 'merged' in i && i.merged ? 'MERGED' : i.state === 'open' ? 'OPEN' : 'CLOSED';
            return states.includes(st);
          });
        }
        filtered = [...filtered].sort((a, b) => (desc ? b.number - a.number : a.number - b.number));
        const afterCursor = typeof f.args.after === 'string' ? f.args.after : '';
        if (afterCursor) {
          const m = /(?:cursor-)?(\d+)/.exec(afterCursor);
          const boundary = m ? Number(m[1]) : null;
          if (boundary !== null) {
            filtered = filtered.filter((i) => (desc ? i.number < boundary : i.number > boundary));
          }
        }
        const lastArg = typeof f.args.last === 'number' ? f.args.last : null;
        if (lastArg !== null) filtered = filtered.slice(Math.max(0, filtered.length - lastArg));
        const first = typeof f.args.first === 'number' ? f.args.first : filtered.length;
        const nodes = filtered.slice(0, first).map((i) => (f.name === 'issues' ? i : pullWithFiles(store, repo, i as Pull)));
        return { totalCount: filtered.length, nodes,
          pageInfo: { hasNextPage: filtered.length > first, endCursor: `cursor-${filtered[first - 1]?.number ?? filtered.length}`, startCursor: `cursor-${filtered[0]?.number ?? 1}` } };
      }
      default: return UNKNOWN;
    }
  }

  if (kind === 'Issue') {
    const issue = value as Issue;
    switch (f.name) {
      case 'id': return `I_${issue.id}`;
      case 'number': return issue.number;
      case 'title': return issue.title;
      case 'body': return issue.body;
      case 'state': return issue.state === 'open' ? 'OPEN' : 'CLOSED';
      case 'createdAt': return issue.createdAt;
      case 'updatedAt': return issue.updatedAt;
      case 'closed': return issue.state === 'closed';
      case 'labels': return { nodes: issue.labels.map((name) => ({ name })) };
      default: return UNKNOWN;
    }
  }

  if (kind === 'PullRequest') {
    const pull = value as Pull & { files?: { path: string; status: string; sha: string }[] };
    switch (f.name) {
      case 'id': return `PR_${pull.id}`;
      case 'number': return pull.number;
      case 'title': return pull.title;
      case 'body': return pull.body;
      case 'state': return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
      case 'merged': return pull.merged;
      case 'mergeable': return pull.mergeable ? 'MERGEABLE' : 'CONFLICTING';
      case 'headRefName': return pull.head;
      case 'baseRefName': return pull.base;
      case 'headRefOid': return pull.headSha;
      case 'baseRefOid': return pull.baseSha;
      case 'createdAt': return pull.createdAt;
      case 'files': {
        const files = (pull.files ?? []).map((x) => ({ path: x.path, additions: 1, deletions: 0, changeType: x.status.toUpperCase() }));
        return {
          totalCount: files.length,
          nodes: files,
          pageInfo: { hasNextPage: false, hasPreviousPage: false, endCursor: null, startCursor: null },
        };
      }
      default: return UNKNOWN;
    }
  }

  if (kind === 'User') {
    const u = value as Record<string, unknown>;
    switch (f.name) {
      case 'login': return u.login;
      case 'id': return u.id;
      case 'databaseId': return u.databaseId ?? 1;
      case 'resourcePath': return u.resourcePath ?? null;
      default: return UNKNOWN;
    }
  }

  if (kind === 'Ref') {
    const r = value as Record<string, unknown>;
    switch (f.name) {
      case 'name': return r.name;
      case 'target': return r.target;
      case 'oid': return (r.target as Record<string, unknown>)?.oid;
      default: return UNKNOWN;
    }
  }

  if (kind === 'Connection') {
    const c = value as Record<string, unknown>;
    switch (f.name) {
      case 'totalCount': return c.totalCount;
      case 'nodes': {
        const list = (c.nodes ?? []) as unknown[];
        return new PreProjected(list.map((item, i) => (item && typeof item === 'object'
          ? resolveFields(nodeKindOf(item), item, f.selections, env, [...path, i])
          : item)));
      }
      case 'edges': {
        const list = (c.nodes ?? []) as unknown[];
        return list.map((item, i) => ({
          cursor: `cursor-${i}`,
          node: item && typeof item === 'object'
            ? resolveFields(nodeKindOf(item), item, f.selections.length ? [] : [], env, [...path, i])
            : item,
        }));
      }
      case 'pageInfo': return c.pageInfo;
      default: return UNKNOWN;
    }
  }

  if (kind === 'Payload') {
    const p = (value ?? {}) as Record<string, unknown>;
    if (p[f.name] !== undefined) return p[f.name];
    return UNKNOWN;
  }

  if (kind === 'Comment') {
    const c = value as Record<string, unknown>;
    switch (f.name) {
      case 'id': return c.id;
      case 'body': return c.body;
      case 'author': return c.author;
      case 'createdAt': return c.createdAt;
      default: return UNKNOWN;
    }
  }

  if (kind === 'Edge') {
    const e = value as Record<string, unknown>;
    switch (f.name) {
      case 'cursor': return e.cursor;
      case 'node': return e.node;
      default: return UNKNOWN;
    }
  }

  if (kind === 'File') {
    const f2 = value as Record<string, unknown>;
    switch (f.name) {
      case 'path': return f2.path;
      case 'additions': return f2.additions ?? 1;
      case 'deletions': return f2.deletions ?? 0;
      case 'changeType': return f2.changeType ?? 'MODIFIED';
      default: return UNKNOWN;
    }
  }

  if (kind === 'PageInfo') {
    const p = value as Record<string, unknown>;
    switch (f.name) {
      case 'hasNextPage': return p.hasNextPage ?? false;
      case 'hasPreviousPage': return p.hasPreviousPage ?? false;
      case 'endCursor': return p.endCursor ?? null;
      case 'startCursor': return p.startCursor ?? null;
      default: return UNKNOWN;
    }
  }

  return UNKNOWN;
}

/** Whether a node of a connection is a pull request or an issue. */
function nodeKindOf(value: unknown): Kind {
  const rec = value as Record<string, unknown>;
  if (!rec || typeof rec !== 'object') return 'Issue';
  if ('path' in rec && !('number' in rec)) return 'File';
  return 'head' in rec || 'merged' in rec ? 'PullRequest' : 'Issue';
}

function pullWithFiles(store: Store, repo: Repo, pull: Pull): Pull & { files: { path: string; status: string; sha: string }[] } {
  const diff = branchDiff(store, repo, pull.base, pull.head, pull.baseSha);
  return Object.assign({}, pull, { files: diff.files });
}

function repoByNodeId(store: Store, nodeId: string): Repo | null {
  const m = /^R_(\d+)$/.exec(nodeId);
  if (!m) return null;
  const id = Number(m[1]);
  for (const repo of store.repos.values()) if (repo.id === id) return repo;
  return null;
}

function findIssueByNodeId(store: Store, nodeId: string): Issue | null {
  const m = /^I_(\d+)$/.exec(nodeId);
  if (!m) return null;
  const id = Number(m[1]);
  for (const list of store.issues.values()) {
    const found = list.find((i) => i.id === id);
    if (found) return found;
  }
  return null;
}

function findPullByNodeId(store: Store, nodeId: string): Pull | null {
  const m = /^PR_(\d+)$/.exec(nodeId);
  if (!m) return null;
  const id = Number(m[1]);
  for (const list of store.pulls.values()) {
    const found = list.find((p) => p.id === id);
    if (found) return found;
  }
  return null;
}

function repoOfPull(store: Store, pull: Pull): Repo | null {
  for (const repo of store.repos.values()) if (repo.id === pull.repoId) return repo;
  return null;
}

function typeIntrospection(name: string): unknown {
  const sets: Record<string, string[]> = {
    Issue: ['id', 'number', 'title', 'state', 'body'],
    PullRequest: ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files'],
    Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
      'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'],
    SearchType: [],
  };
  const fields = sets[name];
  if (!fields) return null;
  const out: Record<string, unknown> = {
    kind: name === 'SearchType' ? 'ENUM' : 'OBJECT',
    name,
    fields: fields.map((f) => ({ name: f, type: { name: 'String', kind: 'SCALAR' } })),
    enumValues: name === 'SearchType'
      ? [{ name: 'ISSUE' }, { name: 'REPOSITORY' }, { name: 'USER' }]
      : null,
  };
  // introspection clients ask for either shape; both are present
  out.inputFields = null;
  out.interfaces = [];
  return out;
}

export function handleGraphql(ctx: Ctx): void {
  if (!ctx.user) { ctx.json(401, { message: 'Requires authentication' }); return; }
  const body = ctx.body as unknown;
  const one = (item: unknown): unknown => {
    const rec = (item ?? {}) as Record<string, unknown>;
    const query = typeof rec.query === 'string' ? rec.query : '';
    if (!query.trim()) return { errors: [{ message: 'Must provide query string.' }] };
    const variables = (rec.variables ?? {}) as Record<string, unknown>;
    const doc = parseDocument(query, variables);
    const env: ResolveEnv = { store: ctx.store, ctx, fragments: doc.fragments, errors: [] };
    if (doc.operations.length === 0) return { errors: [{ message: 'Must provide an operation.' }] };
    let data: Record<string, unknown> = {};
    for (const op of doc.operations) {
      const resolved = resolveFields('Query', null, op, env, []);
      data = { ...data, ...resolved };
    }
    return env.errors.length ? { data, errors: env.errors } : { data };
  };
  if (Array.isArray(body)) { ctx.json(200, body.map(one)); return; }
  ctx.json(200, one(body));
}
