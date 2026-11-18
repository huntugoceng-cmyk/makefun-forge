// GitHub REST v3 surface: repositories, branches, commits, contents, issues,
// labels, comments and pull requests, all served from the store.
import { buildCommit, buildTree, flatten, parseCommit, parseTree } from './git.ts';
import type { Issue, Label, Pull, Repo, Store, User } from './store.ts';

export interface Ctx {
  store: Store;
  user: User | null;
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
  json: (status: number, body: unknown, headers?: Record<string, string>) => void;
  text: (status: number, body: string, headers?: Record<string, string>) => void;
  raw?: (status: number, body: string, contentType: string, headers?: Record<string, string>) => void;
  base: string;
}

const json = (obj: unknown): string => JSON.stringify(obj);

function iso(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Splits a git identity line into GitHub's author object. */
function ident(line: string, store: Store): { name: string; email: string; date: string } {
  const m = /^(.*?) <(.*?)> (\d+) ([+-]\d{4})$/.exec(line ?? '');
  if (!m) return { name: (line ?? '').split(' <')[0] || 'unknown', email: '', date: store.now() };
  const [, name, email, secs] = m;
  return { name, email, date: new Date(Number(secs) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z') };
}

function ownerOf(ctx: Ctx, repo: Repo) {
  return {
    login: repo.owner,
    id: 1,
    node_id: `U_${repo.owner}`,
    avatar_url: `${ctx.base}/avatars/${repo.owner}.png`,
    html_url: `${ctx.base}/${repo.owner}`,
    type: 'User',
    site_admin: false,
  };
}

export function repoJson(ctx: Ctx, repo: Repo) {
  const full = `${repo.owner}/${repo.name}`;
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: full,
    private: repo.private,
    owner: ownerOf(ctx, repo),
    html_url: `${ctx.base}/${full}`,
    description: repo.description,
    fork: false,
    url: `${ctx.base}/api/v3/repos/${full}`,
    created_at: iso(repo.createdAt),
    updated_at: iso(repo.updatedAt),
    pushed_at: repo.pushedAt ? iso(repo.pushedAt) : null,
    homepage: repo.homepage,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    forks_count: 0,
    open_issues_count: (ctx.store.issueList(repo.id) ?? []).filter((i) => i.state === 'open').length,
    default_branch: repo.defaultBranch,
    has_issues: repo.hasIssues,
    topics: repo.topics,
    visibility: repo.private ? 'private' : 'public',
  };
}

function labelJson(l: Label) {
  return { id: l.id, node_id: `L_${l.id}`, name: l.name, color: l.color, description: l.description };
}

function issueJson(ctx: Ctx, repo: Repo, issue: Issue) {
  const full = `${repo.owner}/${repo.name}`;
  return {
    id: issue.id,
    node_id: `I_${issue.id}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    user: { login: issue.user, id: 2, type: 'User', site_admin: false },
    labels: issue.labels.map((name) => ({ name })),
    assignee: issue.assignee ? { login: issue.assignee } : null,
    assignees: issue.assignee ? [{ login: issue.assignee }] : [],
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    html_url: `${ctx.base}/${full}/issues/${issue.number}`,
    url: `${ctx.base}/api/v3/repos/${full}/issues/${issue.number}`,
    repository_url: `${ctx.base}/api/v3/repos/${full}`,
    pull_request: issue.isPull ? { url: `${ctx.base}/api/v3/repos/${full}/pulls/${issue.number}` } : undefined,
  };
}

/** Rendered issue bodies, reused until the issue changes. */
const ISSUE_JSON_CACHE = new Map<number, { sig: string; json: ReturnType<typeof issueJson> }>();

function issueJsonCached(ctx: Ctx, repo: Repo, issue: Issue) {
  // updatedAt moves on every mutation the REST surface makes, and a comment or a label
  // added moves a count beside it: those three date the object this cache keeps.
  const sig = `${ctx.base}|${issue.updatedAt}|${issue.state}|${issue.comments.length}|${issue.labels.length}`;
  const hit = ISSUE_JSON_CACHE.get(issue.id);
  if (hit && hit.sig === sig) return hit.json;
  const json = issueJson(ctx, repo, issue);
  if (ISSUE_JSON_CACHE.size > 5000) ISSUE_JSON_CACHE.clear();
  ISSUE_JSON_CACHE.set(issue.id, { sig, json });
  return json;
}

function pullJson(ctx: Ctx, repo: Repo, pull: Pull) {
  const full = `${repo.owner}/${repo.name}`;
  const headRef = repo.refs.get(`refs/heads/${pull.head}`) ?? pull.headSha;
  const baseRef = repo.refs.get(`refs/heads/${pull.base}`) ?? pull.baseSha;
  return {
    id: pull.id,
    node_id: `PR_${pull.id}`,
    number: pull.number,
    state: pull.merged ? 'closed' : pull.state,
    title: pull.title,
    body: pull.body,
    user: { login: pull.user, id: 2, type: 'User', site_admin: false },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' || pull.merged ? pull.updatedAt : null,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    merged: pull.merged,
    mergeable: pull.mergeable,
    draft: false,
    head: { label: `${repo.owner}:${pull.head}`, ref: pull.head, sha: headRef },
    base: { label: `${repo.owner}:${pull.base}`, ref: pull.base, sha: baseRef },
    html_url: `${ctx.base}/${full}/pull/${pull.number}`,
    url: `${ctx.base}/api/v3/repos/${full}/pulls/${pull.number}`,
  };
}

function paginate<T>(items: T[], query: URLSearchParams): { page: T[]; next: number | null } {
  const perPage = Math.min(100, Math.max(1, Number(query.get('per_page') ?? 30) || 30));
  const page = Math.max(1, Number(query.get('page') ?? 1) || 1);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const next = start + perPage < items.length ? page + 1 : null;
  return { page: slice, next };
}

function linkHeader(ctx: Ctx, nextPage: number | null, perPage: number): Record<string, string> {
  if (nextPage === null) return {};
  const params = new URLSearchParams(ctx.query.toString());
  params.set('page', String(nextPage));
  params.set('per_page', String(perPage));
  const url = `${ctx.base}${ctx.path}?${params.toString()}`;
  return { link: `<${url}>; rel="next"` };
}

function notFound(ctx: Ctx, message = 'Not Found'): void {
  ctx.json(404, { message, documentation_url: 'https://docs.github.com/rest' });
}

function badRequest(ctx: Ctx, message: string): void {
  ctx.json(400, { message });
}

function unprocessable(ctx: Ctx, message: string): void {
  ctx.json(422, { message, errors: [{ resource: 'Issue', code: 'invalid', message }] });
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

export function createIssue(store: Store, repo: Repo, title: string, body: string, user: string,
  labels: string[] = [], opts: { isPull?: boolean } = {}): Issue {
  const list = store.issueList(repo.id);
  const issue: Issue = {
    id: store.nextId(),
    number: list.reduce((m, i) => Math.max(m, i.number), 0) + 1,
    repoId: repo.id,
    title,
    body,
    state: 'open',
    labels,
    assignee: null,
    user,
    createdAt: store.now(),
    updatedAt: store.now(),
    closedAt: null,
    comments: [],
    isPull: opts.isPull ?? false,
  };
  list.push(issue);
  return issue;
}

export function createPull(store: Store, repo: Repo, title: string, head: string, base: string,
  user: string, body = ''): Pull {
  const list = store.pullList(repo.id);
  const baseSha = repo.refs.get(`refs/heads/${base}`) ?? '';
  const headSha = repo.refs.get(`refs/heads/${head}`) ?? '';
  const pull: Pull = {
    id: store.nextId(),
    number: list.reduce((m, p) => Math.max(m, p.number), 0) + 1,
    repoId: repo.id,
    title,
    body,
    head,
    base,
    headSha,
    baseSha,
    state: 'open',
    merged: false,
    mergeable: baseSha !== '' && headSha !== '',
    mergedAt: null,
    mergeCommitSha: null,
    user,
    createdAt: store.now(),
    updatedAt: store.now(),
  };
  list.push(pull);
  const issue = createIssue(store, repo, title, body, user, [], { isPull: true });
  issue.number = pull.number;
  return pull;
}

/** Files a branch adds or changes relative to `base`, as path -> blob sha. */
export function branchDiff(store: Store, repo: Repo, base: string, head: string,
  baseSha?: string): { added: string[]; modified: string[]; removed: string[]; conflicted: boolean; files: { path: string; sha: string; status: string }[] } {
  const a = store.treeAt(repo, base);
  const b = store.treeAt(repo, head);
  const added: string[] = [];
  const modified: string[] = [];
  const removed: string[] = [];
  const files: { path: string; sha: string; status: string }[] = [];
  for (const [path, entry] of b) {
    const prev = a.get(path);
    if (!prev) { added.push(path); files.push({ path, sha: entry.sha, status: 'added' }); }
    else if (prev.sha !== entry.sha) { modified.push(path); files.push({ path, sha: entry.sha, status: 'modified' }); }
  }
  for (const path of a.keys()) if (!b.has(path)) { removed.push(path); files.push({ path, sha: a.get(path)!.sha, status: 'removed' }); }
  const headTouched = new Set([...added, ...modified, ...removed]);
  const baseHead = repo.refs.get(`refs/heads/${base}`);
  const headTip = repo.refs.get(`refs/heads/${head}`);
  let conflicted = false;
  if (baseSha && baseHead && headTip) {
    const mergeBase = findMergeBase(store, baseSha, headTip);
    if (mergeBase) {
      const baseSide = new Set(changedPaths(store, mergeBase, baseHead));
      const headSide = changedPaths(store, mergeBase, headTip);
      conflicted = headSide.some((p) => baseSide.has(p)) && baseHead !== baseSha;
    }
  }
  return { added, modified, removed, conflicted, files };
}

/** The newest commit both tips reach. */
function findMergeBase(store: Store, a: string, b: string): string | null {
  const ancestors = new Set<string>();
  const stack = [a];
  while (stack.length) {
    const cur = stack.pop()!;
    if (ancestors.has(cur)) continue;
    ancestors.add(cur);
    const c = store.commitBody(cur);
    if (c) for (const p of c.parents) stack.push(p);
  }
  const queue = [b];
  const seen = new Set<string>();
  while (queue.length) {
    const cur = queue.shift()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    if (ancestors.has(cur)) return cur;
    const c = store.commitBody(cur);
    if (c) for (const p of c.parents) queue.push(p);
  }
  return null;
}

/** Paths whose blob differs between two commits' trees. */
function changedPaths(store: Store, fromSha: string, toSha: string): string[] {
  const fromCommit = store.commitBody(fromSha);
  const toCommit = store.commitBody(toSha);
  if (!fromCommit || !toCommit) return [];
  const a = flatten(fromCommit.tree, (s) => store.read(s));
  const b = flatten(toCommit.tree, (s) => store.read(s));
  const out: string[] = [];
  for (const [path, entry] of b) {
    const prev = a.get(path);
    if (!prev || prev.sha !== entry.sha) out.push(path);
  }
  for (const path of a.keys()) if (!b.has(path)) out.push(path);
  return out;
}

export function mergePull(ctx: Ctx, repo: Repo, pull: Pull, method: string): { status: number; body: unknown } {
  const store = ctx.store;
  if (pull.merged) return { status: 405, body: { message: 'Pull Request is not mergeable' } };
  const headSha = repo.refs.get(`refs/heads/${pull.head}`);
  const baseSha = repo.refs.get(`refs/heads/${pull.base}`);
  if (!headSha || !baseSha) return { status: 405, body: { message: 'Pull Request is not mergeable' } };
  const diff = branchDiff(store, repo, pull.base, pull.head, pull.baseSha);
  if (diff.conflicted) return { status: 405, body: { message: 'Pull Request is not mergeable' } };

  const headCommit = store.commitBody(headSha);
  const baseCommit = store.commitBody(baseSha);
  if (!headCommit || !baseCommit) return { status: 405, body: { message: 'Pull Request is not mergeable' } };
  const ident = `${pull.user} <${pull.user}@users.noreply.github.com> ${Math.floor(Date.parse(store.now()) / 1000)} +0000`;
  const body = method === 'squash'
    ? buildCommit({ tree: headCommit.tree, parents: [baseSha], author: ident, committer: ident,
      message: `${pull.title} (#${pull.number})\n`, extra: [] })
    : buildCommit({ tree: headCommit.tree, parents: [baseSha, headSha], author: ident, committer: ident,
      message: `Merge pull request #${pull.number} from ${pull.head}\n\n${pull.title}\n`, extra: [] });
  const sha = store.put('commit', body);
  repo.refs.set(`refs/heads/${pull.base}`, sha);
  repo.updatedAt = Date.parse(store.now());
  pull.merged = true;
  pull.state = 'closed';
  pull.mergeCommitSha = sha;
  pull.mergedAt = store.now();
  pull.updatedAt = store.now();
  return {
    status: 200,
    body: { sha, merged: true, message: method === 'squash' ? 'Pull request successfully merged' : 'Pull request successfully merged' },
  };
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _unusedParseCommit = parseCommit;

export function handleRest(ctx: Ctx): boolean {
  const store = ctx.store;
  const path = ctx.path;
  if (!path.startsWith('/api/v3')) return false;

  const authHeader = ctx.user ? null : null;
  void authHeader;

  if (path === '/api/v3/' || path === '/api/v3') {
    ctx.json(200, {
      current_user_url: `${ctx.base}/api/v3/user`,
      repository_url: `${ctx.base}/api/v3/repos/{owner}/{repo}`,
      user_repositories_url: `${ctx.base}/api/v3/user/repos`,
      graphql_url: `${ctx.base}/api/graphql`,
    }, { 'x-oauth-scopes': 'repo, read:org' });
    return true;
  }
  if (path === '/api/v3/meta') {
    ctx.json(200, {
      verifiable_password_authentication: false,
      installed_version: '3.0.0-makefun',
      hooks: [],
      git: [],
      ssh_key_fingerprints: {},
    });
    return true;
  }
  if (!ctx.user) {
    ctx.json(401, { message: 'Requires authentication' });
    return true;
  }
  const me = ctx.user;

  if (path === '/api/v3/user') {
    ctx.json(200, { login: me.login, id: me.id, node_id: `U_${me.login}`, type: 'User', site_admin: false });
    return true;
  }

  if (path === '/api/v3/user/repos') {
    if (ctx.method === 'GET') {
      const all = store.reposOf(me.login);
      const { page, next } = paginate(all, ctx.query);
      ctx.json(200, page.map((r) => repoJson(ctx, r)), linkHeader(ctx, next, Number(ctx.query.get('per_page') ?? 30)));
      return true;
    }
    if (ctx.method === 'POST') {
      const b = asRecord(ctx.body);
      const name = str(b.name);
      if (!name) { unprocessable(ctx, 'Repository creation failed.'); return true; }
      if (store.repo(me.login, name)) {
        ctx.json(422, { message: 'Repository creation failed.', errors: [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }] });
        return true;
      }
      const repo = store.createRepo(me.login, name, {
        description: str(b.description),
        private: b.private === true,
        autoInit: b.auto_init === true,
        defaultBranch: str(b.default_branch) || 'main',
        homepage: typeof b.homepage === 'string' ? b.homepage : null,
        topics: Array.isArray(b.topics) ? b.topics.map(String) : [],
      });
      ctx.json(201, repoJson(ctx, repo));
      return true;
    }
    return false;
  }

  const repoMatch = /^\/api\/v3\/repos\/([^/]+)\/([^/]+)$/.exec(path);
  if (repoMatch) {
    const [, owner, name] = repoMatch;
    const repo = store.repo(owner, name);
    if (!repo || repo.owner.toLowerCase() !== me.login.toLowerCase()) { notFound(ctx); return true; }
    if (ctx.method === 'GET') {
      ctx.json(200, repoJson(ctx, repo));
      return true;
    }
    if (ctx.method === 'PATCH') {
      const b = asRecord(ctx.body);
      if (typeof b.description === 'string') repo.description = b.description;
      if (typeof b.name === 'string' && b.name) { store.repos.delete(store.key(repo.owner, repo.name)); repo.name = b.name; store.repos.set(store.key(repo.owner, repo.name), repo); }
      if (typeof b.private === 'boolean') repo.private = b.private;
      if (typeof b.homepage === 'string') repo.homepage = b.homepage;
      if (typeof b.default_branch === 'string') repo.defaultBranch = b.default_branch;
      repo.updatedAt = Date.parse(store.now());
      ctx.json(200, repoJson(ctx, repo));
      return true;
    }
    if (ctx.method === 'DELETE') {
      store.deleteRepo(repo);
      ctx.text(204, '');
      return true;
    }
    return false;
  }

  const sub = /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/(.*)$/.exec(path);
  if (!sub) return false;
  const [, owner, name, restRaw] = sub;
  const repo = store.repo(owner, name);
  if (!repo || repo.owner.toLowerCase() !== me.login.toLowerCase()) { notFound(ctx); return true; }
  const rest = restRaw.replace(/\/$/, '');
  const full = `${repo.owner}/${repo.name}`;

  if (rest === 'branches' && ctx.method === 'GET') {
    const branches = [...repo.refs.entries()]
      .filter(([ref]) => ref.startsWith('refs/heads/'))
      .map(([ref, sha]) => ({ name: ref.slice(11), commit: { sha, url: `${ctx.base}/api/v3/repos/${full}/commits/${sha}` }, protected: false }));
    ctx.json(200, branches);
    return true;
  }

  const branchMatch = /^branches\/(.+)$/.exec(rest);
  if (branchMatch && ctx.method === 'GET') {
    const branch = branchMatch[1];
    const sha = repo.refs.get(`refs/heads/${branch}`);
    if (!sha) { notFound(ctx); return true; }
    ctx.json(200, { name: branch, commit: { sha, url: `${ctx.base}/api/v3/repos/${full}/commits/${sha}` }, protected: false });
    return true;
  }

  if (rest === 'commits' && ctx.method === 'GET') {
    const branch = ctx.query.get('sha') ?? repo.defaultBranch;
    const head = repo.refs.get(`refs/heads/${branch}`) ?? repo.refs.get(branch) ?? (store.commitBody(branch) ? branch : null);
    if (!head) { ctx.json(200, []); return true; }
    const found: { sha: string; commit: ReturnType<typeof store.commitBody> }[] = [];
    const seen = new Set<string>();
    const stack = [head];
    while (stack.length && found.length < 500) {
      const sha = stack.pop()!;
      if (seen.has(sha)) continue;
      seen.add(sha);
      const c = store.commitBody(sha);
      if (!c) continue;
      found.push({ sha, commit: c });
      for (const p of c.parents) stack.push(p);
    }
    const stamp = (line: string): number => {
      const m = /(\d+) [+-]\d{4}$/.exec(line ?? '');
      return m ? Number(m[1]) : 0;
    };
    found.sort((a, b) => stamp(b.commit!.committer) - stamp(a.commit!.committer));
    const out = found.slice(0, 100).map(({ sha, commit: c }) => ({
      sha,
      node_id: `C_${sha.slice(0, 10)}`,
      commit: {
        author: ident(c!.author, store),
        committer: ident(c!.committer, store),
        message: c!.message,
        tree: { sha: c!.tree },
        comment_count: 0,
      },
      parents: c!.parents.map((p) => ({ sha: p })),
    }));
    ctx.json(200, out);
    return true;
  }

  const commitMatch = /^commits\/([0-9a-f]{7,40})$/.exec(rest);
  if (commitMatch && ctx.method === 'GET') {
    const sha = commitMatch[1];
    const c = store.commitBody(sha);
    if (!c) { notFound(ctx); return true; }
    const files = flatten(c.tree, (s) => store.read(s));
    ctx.json(200, {
      sha,
      commit: { message: c.message, tree: { sha: c.tree }, author: { name: c.author.split(' <')[0] }, committer: { name: c.committer.split(' <')[0] } },
      parents: c.parents.map((p) => ({ sha: p })),
      files: [...files.entries()].map(([path, e]) => ({ filename: path, sha: e.sha, status: 'modified', changes: 1, additions: 1, deletions: 0 })),
    });
    return true;
  }

  const contentMatch = /^contents(?:\/(.*))?$/.exec(rest);
  if (contentMatch) {
    const filePath = decodeURIComponent(contentMatch[1] ?? '');
    const refParam = ctx.query.get('ref');
    const tree = refParam ? store.treeAt(repo, refParam) : store.treeAt(repo);
    if (ctx.method === 'GET') {
      if (!filePath) {
        const out: unknown[] = [];
        const seenDirs = new Set<string>();
        for (const [p, e] of tree) {
          const head = p.includes('/') ? p.slice(0, p.indexOf('/')) : null;
          if (head && !seenDirs.has(head)) {
            seenDirs.add(head);
            out.push({ type: 'dir', name: head, path: head, sha: '', size: 0,
              url: `${ctx.base}/api/v3/repos/${full}/contents/${head}` });
            continue;
          }
          if (head) continue;
          out.push({ type: 'file', name: p, path: p, sha: e.sha, size: store.read(e.sha)?.body.length ?? 0,
            mode: e.mode, url: `${ctx.base}/api/v3/repos/${full}/contents/${p}` });
        }
        ctx.json(200, out);
        return true;
      }
      const entry = tree.get(filePath);
      if (!entry) {
        // a directory: everything under `filePath/`
        const prefix = `${filePath.replace(/\/$/, '')}/`;
        const children = [...tree.entries()].filter(([p]) => p.startsWith(prefix));
        if (children.length === 0) { notFound(ctx); return true; }
        const seenDirs = new Set<string>();
        const out: unknown[] = [];
        for (const [p, e] of children) {
          const rel = p.slice(prefix.length);
          if (rel.includes('/')) {
            const dir = rel.slice(0, rel.indexOf('/'));
            if (seenDirs.has(dir)) continue;
            seenDirs.add(dir);
            out.push({ type: 'dir', name: dir, path: `${prefix}${dir}`, sha: '', size: 0,
              url: `${ctx.base}/api/v3/repos/${full}/contents/${prefix}${dir}` });
            continue;
          }
          out.push({ type: 'file', name: rel, path: p, sha: e.sha, size: store.read(e.sha)?.body.length ?? 0,
            mode: e.mode, url: `${ctx.base}/api/v3/repos/${full}/contents/${p}` });
        }
        ctx.json(200, out);
        return true;
      }
      const obj = store.read(entry.sha);
      const content = obj ? obj.body.toString('base64') : '';
      ctx.json(200, {
        type: 'file', name: filePath.split('/').pop(), path: filePath, sha: entry.sha,
        size: obj ? obj.body.length : 0, encoding: 'base64', content,
        url: `${ctx.base}/api/v3/repos/${full}/contents/${filePath}`,
      });
      return true;
    }
    if (ctx.method === 'PUT') {
      const b = asRecord(ctx.body);
      const message = str(b.message) || `Update ${filePath}`;
      const encoded = str(b.content);
      const shaGiven = typeof b.sha === 'string' ? b.sha : '';
      const branchName = str(b.branch) || repo.defaultBranch;
      if (branchName !== repo.defaultBranch && !repo.refs.get(`refs/heads/${branchName}`)) {
        ctx.json(422, { message: `Branch ${branchName} not found` });
        return true;
      }
      const branchTree = store.treeAt(repo, branchName);
      const existing = branchTree.get(filePath);
      if (existing && shaGiven && existing.sha !== shaGiven) {
        ctx.json(409, { message: 'sha does not match' });
        return true;
      }
      const decoded = Buffer.from(encoded.replace(/\n/g, ''), 'base64');
      const files = new Map<string, Buffer>();
      for (const [p, e] of branchTree) {
        const obj = store.read(e.sha);
        if (obj) files.set(p, obj.body);
      }
      files.set(filePath, decoded);
      const parent = store.headSha(repo, branchName) ?? null;
      const commitSha = store.commitFiles(repo, parent, files, message, me.login, branchName);
      const savedSha = store.treeAt(repo, branchName).get(filePath)?.sha ?? store.put('blob', decoded);
      ctx.json(existing ? 200 : 201, {
        content: {
          name: filePath.split('/').pop(), path: filePath, sha: savedSha,
          size: decoded.length, type: 'file', encoding: 'base64',
          content: decoded.toString('base64'),
          url: `${ctx.base}/api/v3/repos/${full}/contents/${filePath}`,
        },
        commit: {
          sha: commitSha, message, url: `${ctx.base}/api/v3/repos/${full}/commits/${commitSha}`,
          author: { name: me.login, email: `${me.login}@users.noreply.github.com`, date: store.now() },
          committer: { name: me.login, email: `${me.login}@users.noreply.github.com`, date: store.now() },
          tree: { sha: store.commitBody(commitSha)?.tree ?? '', url: `${ctx.base}/api/v3/repos/${full}/git/trees/${store.commitBody(commitSha)?.tree ?? ''}` },
        },
      });
      return true;
    }
    if (ctx.method === 'DELETE') {
      const b = asRecord(ctx.body);
      const existing = tree.get(filePath);
      if (!existing) { notFound(ctx); return true; }
      if (typeof b.sha === 'string' && b.sha && b.sha !== existing.sha) {
        ctx.json(409, { message: 'sha does not match' });
        return true;
      }
      const files = new Map<string, Buffer>();
      for (const [p, e] of tree) {
        if (p === filePath) continue;
        const obj = store.read(e.sha);
        if (obj) files.set(p, obj.body);
      }
      const parent = store.headSha(repo) ?? null;
      const commitSha = store.commitFiles(repo, parent, files, str(b.message) || `Delete ${filePath}`, me.login);
      ctx.json(200, { commit: { sha: commitSha, message: 'deleted' }, content: null });
      return true;
    }
  }

  if (rest === 'labels') {
    if (ctx.method === 'POST') {
      const b = asRecord(ctx.body);
      const labelName = str(b.name);
      if (!labelName) { unprocessable(ctx, 'name is required'); return true; }
      const list = store.labelList(repo.id);
      const existing = list.find((l) => l.name === labelName);
      if (existing) { ctx.json(422, { message: 'Validation Failed', errors: [{ code: 'already_exists', field: 'name' }] }); return true; }
      const label: Label = { id: store.nextId(), name: labelName, color: str(b.color) || 'ededed', description: str(b.description) };
      list.push(label);
      ctx.json(201, labelJson(label));
      return true;
    }
    if (ctx.method === 'GET') { ctx.json(200, store.labelList(repo.id).map(labelJson)); return true; }
  }

  if (rest === 'issues/:number' || /^issues\/\d+$/.test(rest)) {
    const num = Number(rest.split('/')[1]);
    const issue = store.issueByNumber(repo.id, num);
    if (ctx.method === 'GET') {
      if (!issue) { notFound(ctx); return true; }
      ctx.json(200, issueJsonCached(ctx, repo, issue));
      return true;
    }
    if (ctx.method === 'PATCH') {
      if (!issue) { notFound(ctx); return true; }
      const b = asRecord(ctx.body);
      if (typeof b.title === 'string') issue.title = b.title;
      if (typeof b.body === 'string') issue.body = b.body;
      if (typeof b.state === 'string') {
        issue.state = b.state === 'closed' ? 'closed' : 'open';
        issue.closedAt = issue.state === 'closed' ? store.now() : null;
      }
      if (Array.isArray(b.labels)) issue.labels = b.labels.map(String);
      issue.updatedAt = store.now();
      ctx.json(200, issueJson(ctx, repo, issue));
      return true;
    }
  }

  const commentsMatch = /^issues\/(\d+)\/comments$/.exec(rest);
  if (commentsMatch) {
    const num = Number(commentsMatch[1]);
    const issue = store.issueByNumber(repo.id, num, true);
    if (!issue) { notFound(ctx); return true; }
    if (ctx.method === 'GET') {
      ctx.json(200, issue.comments.map((c) => ({ id: c.id, body: c.body, user: { login: c.user }, created_at: c.createdAt })));
      return true;
    }
    if (ctx.method === 'POST') {
      const b = asRecord(ctx.body);
      const comment = { id: store.nextId(), body: str(b.body), user: me.login, createdAt: store.now() };
      issue.comments.push(comment);
      ctx.json(201, { id: comment.id, body: comment.body, user: { login: comment.user }, created_at: comment.createdAt });
      return true;
    }
  }

  if (rest === 'issues') {
    if (ctx.method === 'POST') {
      const b = asRecord(ctx.body);
      const title = str(b.title);
      if (!title) { unprocessable(ctx, 'title is required'); return true; }
      const wanted = Array.isArray(b.labels) ? b.labels.map(String) : [];
      const known = store.labelList(repo.id).map((l) => l.name);
      const missing = wanted.filter((w) => !known.includes(w));
      if (missing.length) {
        unprocessable(ctx, `Label does not exist: ${missing.join(', ')}`);
        return true;
      }
      const issue = createIssue(store, repo, title, str(b.body), me.login, wanted);
      ctx.json(201, issueJson(ctx, repo, issue));
      return true;
    }
    if (ctx.method === 'GET') {
      const state = ctx.query.get('state') ?? 'open';
      const direction = (ctx.query.get('direction') ?? 'desc').toLowerCase();
      const sort = (ctx.query.get('sort') ?? 'created').toLowerCase();
      let all = store.issueList(repo.id).filter((i) => !i.isPull && (state === 'all' || i.state === state));
      all = [...all].sort((a, b) => {
        const key = sort === 'updated' ? Date.parse(b.updatedAt) - Date.parse(a.updatedAt) : b.number - a.number;
        return direction === 'asc' ? -key : key;
      });
      const { page, next } = paginate(all, ctx.query);
      ctx.json(200, page.map((i) => issueJson(ctx, repo, i)), linkHeader(ctx, next, Number(ctx.query.get('per_page') ?? 30)));
      return true;
    }
  }

  if (rest === 'pulls') {
    if (ctx.method === 'POST') {
      const b = asRecord(ctx.body);
      const head = str(b.head);
      const base = str(b.base);
      if (!head || !base) { unprocessable(ctx, 'head and base are required'); return true; }
      if (!repo.refs.get(`refs/heads/${head}`) || !repo.refs.get(`refs/heads/${base}`)) {
        unprocessable(ctx, 'No commits between base and head');
        return true;
      }
      const pull = createPull(store, repo, str(b.title), head, base, me.login, str(b.body));
      ctx.json(201, pullJson(ctx, repo, pull));
      return true;
    }
    if (ctx.method === 'GET') {
      const state = ctx.query.get('state') ?? 'open';
      const all = store.pullList(repo.id).filter((p) => state === 'all' || p.state === state);
      const { page, next } = paginate(all, ctx.query);
      ctx.json(200, page.map((p) => pullJson(ctx, repo, p)), linkHeader(ctx, next, Number(ctx.query.get('per_page') ?? 30)));
      return true;
    }
  }

  const pullFiles = /^pulls\/(\d+)\/files$/.exec(rest);
  if (pullFiles && ctx.method === 'GET') {
    const pull = store.pullList(repo.id).find((p) => p.number === Number(pullFiles[1]));
    if (!pull) { notFound(ctx); return true; }
    const diff = branchDiff(store, repo, pull.base, pull.head);
    ctx.json(200, diff.files.map((f) => ({ filename: f.path, status: f.status, sha: f.sha, additions: 1, deletions: 0, changes: 1 })));
    return true;
  }

  const pullMerge = /^pulls\/(\d+)\/merge$/.exec(rest);
  if (pullMerge && ctx.method === 'PUT') {
    const pull = store.pullList(repo.id).find((p) => p.number === Number(pullMerge[1]));
    if (!pull) { notFound(ctx); return true; }
    const b = asRecord(ctx.body);
    const result = mergePull(ctx, repo, pull, str(b.merge_method) || 'merge');
    ctx.json(result.status, result.body);
    return true;
  }

  const pullMatch = /^pulls\/(\d+)$/.exec(rest);
  if (pullMatch) {
    const pull = store.pullList(repo.id).find((p) => p.number === Number(pullMatch[1]));
    if (!pull) { notFound(ctx); return true; }
    if (ctx.method === 'GET') { ctx.json(200, pullJson(ctx, repo, pull)); return true; }
    if (ctx.method === 'PATCH') {
      const b = asRecord(ctx.body);
      if (typeof b.title === 'string') pull.title = b.title;
      if (typeof b.body === 'string') pull.body = b.body;
      if (typeof b.state === 'string') { pull.state = b.state === 'closed' ? 'closed' : 'open'; pull.updatedAt = store.now(); }
      ctx.json(200, pullJson(ctx, repo, pull));
      return true;
    }
  }

  if (rest.startsWith('git/')) {
    const [kind, ...tail] = rest.slice(4).split('/');
    const arg = tail.join('/');

    if (kind === 'refs') {
      if (ctx.method === 'GET' && !arg) {
        const refs = [...repo.refs.entries()].map(([ref, sha]) => ({ ref, node_id: `R_${ref}`, url: `${ctx.base}/api/v3/repos/${full}/git/refs/${ref.slice(5)}`, object: { sha, type: 'commit', url: `${ctx.base}/api/v3/repos/${full}/git/commits/${sha}` } }));
        ctx.json(200, refs);
        return true;
      }
      if (ctx.method === 'POST' && !arg) {
        const b = asRecord(ctx.body);
        const ref = str(b.ref);
        const sha = str(b.sha);
        if (!ref || !sha) { unprocessable(ctx, 'ref and sha are required'); return true; }
        if (!store.read(sha)) { unprocessable(ctx, 'Object does not exist'); return true; }
        const current = repo.refs.get(ref);
        if (current && current !== sha) { ctx.json(422, { message: 'Reference already exists' }); return true; }
        repo.refs.set(ref, sha);
        repo.updatedAt = Date.parse(store.now());
        ctx.json(201, { ref, node_id: `R_${ref}`, url: `${ctx.base}/api/v3/repos/${full}/git/refs/${ref.slice(5)}`, object: { sha, type: 'commit' } });
        return true;
      }
      if (arg) {
        const ref = arg.startsWith('refs/') ? arg : `refs/${arg}`;
        const current = repo.refs.get(ref) ?? repo.refs.get(arg) ?? null;
        if (ctx.method === 'GET') {
          if (!current) { notFound(ctx); return true; }
          ctx.json(200, { ref, node_id: `R_${ref}`, url: `${ctx.base}/api/v3/repos/${full}/git/refs/${arg}`, object: { sha: current, type: 'commit' } });
          return true;
        }
        if (ctx.method === 'PATCH') {
          if (!current) { notFound(ctx); return true; }
          const b = asRecord(ctx.body);
          const sha = str(b.sha);
          if (!sha || !store.read(sha)) { unprocessable(ctx, 'Object does not exist'); return true; }
          const force = b.force === true;
          if (!force && !isAncestorCommit(store, current, sha)) { ctx.json(422, { message: 'Update is not a fast forward' }); return true; }
          repo.refs.set(ref, sha);
          ctx.json(200, { ref, object: { sha, type: 'commit' } });
          return true;
        }
        if (ctx.method === 'DELETE') {
          if (!current) { notFound(ctx); return true; }
          repo.refs.delete(ref);
          ctx.text(204, '');
          return true;
        }
      }
    }

    if (kind === 'commits') {
      if (ctx.method === 'POST' && !arg) {
        const b = asRecord(ctx.body);
        const tree = str(b.tree);
        const parents = Array.isArray(b.parents) ? b.parents.map(String) : [];
        const message = str(b.message);
        if (!tree || !store.read(tree)) { unprocessable(ctx, 'tree is required'); return true; }
        const author = asRecord(b.author);
        const who = str(author.name) || me.login;
        const email = str(author.email) || `${me.login}@users.noreply.github.com`;
        const when = str(author.date) || store.now();
        const secs = Math.floor(Date.parse(when) / 1000) || Math.floor(Date.parse(store.now()) / 1000);
        const ident = `${who} <${email}> ${secs} +0000`;
        const sha = store.put('commit', buildCommit({ tree, parents, author: ident, committer: ident, message: message.endsWith('\n') ? message : `${message}\n`, extra: [] }));
        ctx.json(201, { sha, node_id: `C_${sha}`, message, tree: { sha: tree }, parents: parents.map((p) => ({ sha: p })),
          author: { name: who, email, date: when }, committer: { name: who, email, date: when },
          url: `${ctx.base}/api/v3/repos/${full}/git/commits/${sha}` });
        return true;
      }
      if (ctx.method === 'GET' && arg) {
        const sha = repo.refs.get(`refs/heads/${arg}`) ?? arg;
        const c = store.commitBody(sha);
        if (!c) { notFound(ctx); return true; }
        ctx.json(200, { sha, node_id: `C_${sha}`, message: c.message.trim(), tree: { sha: c.tree },
          parents: c.parents.map((p) => ({ sha: p })), author: ident(c.author, store), committer: ident(c.committer, store),
          url: `${ctx.base}/api/v3/repos/${full}/git/commits/${sha}` });
        return true;
      }
    }

    if (kind === 'trees') {
      if (ctx.method === 'POST' && !arg) {
        const b = asRecord(ctx.body);
        const base = str(b.base_tree);
        const files = new Map<string, { sha: string; mode: string }>();
        if (base) {
          const baseCommit = store.commitBody(base);
          const baseTree = baseCommit ? baseCommit.tree : base;
          for (const [p, e] of flatten(baseTree, (s) => store.read(s))) files.set(p, e);
        }
        const entries = Array.isArray(b.tree) ? b.tree.map(asRecord) : [];
        for (const entry of entries) {
          const path = str(entry.path);
          if (!path) continue;
          if (entry.sha !== undefined && str(entry.sha)) {
            files.set(path, { sha: str(entry.sha), mode: str(entry.mode) || (entry.type === 'tree' ? '40000' : '100644') });
          } else if (typeof entry.content === 'string') {
            const sha = store.put('blob', Buffer.from(entry.content, 'utf8'));
            files.set(path, { sha, mode: str(entry.mode) || '100644' });
          }
        }
        const treeSha = buildTreeFromFiles(store, files);
        ctx.json(201, { sha: treeSha, url: `${ctx.base}/api/v3/repos/${full}/git/trees/${treeSha}`, tree: [...files.entries()].map(([p, e]) => ({ path: p, mode: e.mode, type: e.mode === '40000' ? 'tree' : 'blob', sha: e.sha })) });
        return true;
      }
      if (ctx.method === 'GET' && arg) {
        const treeSha = repo.refs.get(`refs/heads/${arg}`) ?? arg;
        const commit = store.commitBody(treeSha);
        const actual = commit ? commit.tree : treeSha;
        const obj = store.read(actual);
        if (!obj || obj.type !== 'tree') { notFound(ctx); return true; }
        const recursive = ctx.query.get('recursive') !== null;
        const entries = recursive
          ? [...flatten(actual, (s) => store.read(s)).entries()].map(([p, e]) => ({ path: p, mode: e.mode, type: 'blob', sha: e.sha, size: store.read(e.sha)?.body.length ?? 0 }))
          : parseTreeOf(store, actual);
        ctx.json(200, { sha: actual, url: `${ctx.base}/api/v3/repos/${full}/git/trees/${actual}`, tree: entries, truncated: false });
        return true;
      }
    }

    if (kind === 'blobs') {
      if (ctx.method === 'POST' && !arg) {
        const b = asRecord(ctx.body);
        const content = str(b.content);
        const buf = str(b.encoding) === 'base64' ? Buffer.from(content, 'base64') : Buffer.from(content, 'utf8');
        const sha = store.put('blob', buf);
        ctx.json(201, { sha, url: `${ctx.base}/api/v3/repos/${full}/git/blobs/${sha}` });
        return true;
      }
      if (ctx.method === 'GET' && arg) {
        const obj = store.read(arg);
        if (!obj) { notFound(ctx); return true; }
        ctx.json(200, { sha: arg, size: obj.body.length, encoding: 'base64', content: obj.body.toString('base64') });
        return true;
      }
    }
  }

  return false;
}

function isAncestorCommit(store: Store, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === ancestor) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const c = store.commitBody(cur);
    if (c) for (const p of c.parents) stack.push(p);
  }
  return false;
}

function parseTreeOf(store: Store, sha: string): unknown[] {
  const obj = store.read(sha);
  if (!obj || obj.type !== 'tree') return [];
  const out: unknown[] = [];
  let i = 0;

  for (const e of parseTree(obj.body)) {
    out.push({ path: e.name, mode: e.mode, type: e.mode === '40000' ? 'tree' : 'blob', sha: e.sha, size: e.mode === '40000' ? 0 : (store.read(e.sha)?.body.length ?? 0) });
  }
  void i;
  return out;
}

/** Builds nested trees from a flat path -> entry map and returns the root tree sha. */
function buildTreeFromFiles(store: Store, files: Map<string, { sha: string; mode: string }>): string {
  const root = new Map<string, { sha: string; mode: string }>();
  const dirs = new Map<string, Map<string, { sha: string; mode: string }>>();
  for (const [path, entry] of files) {
    const slash = path.indexOf('/');
    if (slash === -1) { root.set(path, entry); continue; }
    const dir = path.slice(0, slash);
    if (!dirs.has(dir)) dirs.set(dir, new Map());
    dirs.get(dir)!.set(path.slice(slash + 1), entry);
  }
  for (const [dir, children] of dirs) {
    root.set(dir, { sha: buildTreeFromFiles(store, children), mode: '40000' });
  }
  const entries = [...root.entries()].map(([name, e]) => ({ name, sha: e.sha, mode: e.mode }));
  return store.put('tree', buildTree(entries));
}

