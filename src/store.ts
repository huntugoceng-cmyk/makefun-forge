// The forge's own store: users, repositories, git objects and refs, issues,
// labels and pull requests. One process, no outside service.
import { buildCommit, buildTree, flatten, objectId, parseCommitCached, parseTree } from './git.ts';
import type { ObjType, PackedObject, TreeEntry } from './git.ts';

export interface User {
  id: number;
  login: string;
  token: string;
  name: string;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  refs: Map<string, string>;
  createdAt: number;
  updatedAt: number;
  pushedAt: number | null;
  autoInit: boolean;
  hasIssues: boolean;
  homepage: string | null;
  topics: string[];
}

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string;
}

export interface Issue {
  id: number;
  number: number;
  repoId: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  assignee: string | null;
  user: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  comments: Comment[];
  isPull: boolean;
}

export interface Comment {
  id: number;
  body: string;
  user: string;
  createdAt: string;
}

export interface Pull {
  id: number;
  number: number;
  repoId: number;
  title: string;
  body: string;
  head: string;
  base: string;
  headSha: string;
  baseSha: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergeable: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  user: string;
  createdAt: string;
  updatedAt: string;
}

export const NOW_ISO = (iso: string): string => iso;

/** Refs a repository holds, plus a version that every ref write bumps: the surfaces
 *  that advertise or pack this repository's tip cache their bytes against it. */
export class Refs extends Map<string, string> {
  version = 0;

  set(key: string, value: string): this {
    const had = this.get(key);
    super.set(key, value);
    if (had !== value) this.version++;
    return this;
  }

  delete(key: string): boolean {
    const had = super.delete(key);
    if (had) this.version++;
    return had;
  }
}

export class Store {
  users = new Map<string, User>();
  tokens = new Map<string, User>();
  repos = new Map<string, Repo>();
  objects = new Map<string, PackedObject>();
  issues = new Map<number, Issue[]>();
  pulls = new Map<number, Pull[]>();
  labels = new Map<number, Label[]>();
  private seq = 1000;
  /** Fixed clock: every timestamp the store writes comes from here. */
  private clock: () => string;
  private tick = 0;
  /** number -> issue, per repository: the REST read path asks for the same issue over and over. */
  private issueIndex = new Map<number, Map<number, Issue>>();

  constructor(now?: string) {
    const base = now ? Date.parse(now) : Date.parse('2026-11-18T00:00:00Z');
    this.clock = () => new Date(base + this.tick++ * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  }

  nextId(): number {
    return ++this.seq;
  }

  now(): string {
    return this.clock();
  }

  addUser(login: string, token: string): User {
    const existing = this.users.get(login.toLowerCase());
    if (existing) {
      existing.token = token;
      this.tokens.set(token, existing);
      return existing;
    }
    const u: User = { id: this.nextId(), login, token, name: login };
    this.users.set(login.toLowerCase(), u);
    this.tokens.set(token, u);
    return u;
  }

  userByToken(token: string | null | undefined): User | null {
    if (!token) return null;
    return this.tokens.get(token) ?? null;
  }

  key(owner: string, name: string): string {
    return `${owner.toLowerCase()}/${name.toLowerCase()}`;
  }

  repo(owner: string, name: string): Repo | null {
    return this.repos.get(this.key(owner, name)) ?? null;
  }

  reposOf(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const r of this.repos.values()) if (r.owner.toLowerCase() === owner.toLowerCase()) out.push(r);
    return out.sort((a, b) => a.id - b.id);
  }

  createRepo(owner: string, name: string, opts: Partial<Repo> = {}): Repo {
    const repo: Repo = {
      id: this.nextId(),
      owner,
      name,
      description: opts.description ?? '',
      private: opts.private ?? false,
      defaultBranch: opts.defaultBranch ?? 'main',
      refs: new Refs(),
      createdAt: Date.parse(this.now()),
      updatedAt: Date.parse(this.now()),
      pushedAt: null,
      autoInit: opts.autoInit ?? false,
      hasIssues: opts.hasIssues ?? true,
      homepage: opts.homepage ?? null,
      topics: opts.topics ?? [],
    };
    this.repos.set(this.key(owner, name), repo);
    this.issues.set(repo.id, []);
    this.pulls.set(repo.id, []);
    this.labels.set(repo.id, []);
    this.issueIndex.set(repo.id, new Map());
    if (repo.autoInit) this.initRepo(repo);
    return repo;
  }

  deleteRepo(repo: Repo): void {
    this.repos.delete(this.key(repo.owner, repo.name));
    this.issues.delete(repo.id);
    this.pulls.delete(repo.id);
    this.labels.delete(repo.id);
    this.issueIndex.delete(repo.id);
  }

  read(sha: string): PackedObject | null {
    return this.objects.get(sha) ?? null;
  }

  put(type: ObjType, body: Buffer): string {
    const id = objectId(type, body);
    if (!this.objects.has(id)) this.objects.set(id, { type, body });
    return id;
  }

  commitBody(sha: string): ReturnType<typeof parseCommitCached> | null {
    const obj = this.read(sha);
    if (!obj || obj.type !== 'commit') return null;
    return parseCommitCached(sha, obj.body);
  }

  /** Writes a commit on top of `parent` whose tree holds `files`. */
  commitFiles(repo: Repo, parent: string | null, files: Map<string, Buffer>, message: string,
    author: string, branch = repo.defaultBranch): string {
    const entries: TreeEntry[] = [];
    for (const [path, content] of files) {
      entries.push({ mode: '100644', name: path, sha: this.put('blob', content) });
    }
    const tree = this.put('tree', buildTree(entries));
    const ident = `${author} <${author}@users.noreply.github.com> ${Math.floor(Date.parse(this.now()) / 1000)} +0000`;
    const body = buildCommit({
      tree,
      parents: parent ? [parent] : [],
      author: ident,
      committer: ident,
      message: message,
      extra: [],
    });
    const sha = this.put('commit', body);
    repo.refs.set(`refs/heads/${branch}`, sha);
    repo.pushedAt = Date.parse(this.now());
    repo.updatedAt = Date.parse(this.now());
    return sha;
  }

  initRepo(repo: Repo): void {
    const readme = Buffer.from(`# ${repo.name}\n`, 'utf8');
    this.commitFiles(repo, null, new Map([[`README.md`, readme]]), 'Initial commit', repo.owner);
  }

  treeAt(repo: Repo, ref = repo.defaultBranch): Map<string, { sha: string; mode: string }> {
    const sha = repo.refs.get(`refs/heads/${ref}`) ?? repo.refs.get(ref) ?? null;
    if (!sha) return new Map();
    const commit = this.commitBody(sha);
    if (!commit) return new Map();
    return flatten(commit.tree, (s) => this.read(s));
  }

  headSha(repo: Repo, ref = repo.defaultBranch): string | null {
    return repo.refs.get(`refs/heads/${ref}`) ?? null;
  }

  /** Objects a clone of `tips` at `depth` needs: commits, their trees and blobs, tags. */
  reachable(repo: Repo, tips: string[], depth: number | null): { ids: string[]; shallow: string[] } {
    void repo;
    const ids: string[] = [];
    const seen = new Set<string>();
    const shallow: string[] = [];

    const addTree = (treeSha: string): void => {
      if (seen.has(treeSha)) return;
      seen.add(treeSha);
      ids.push(treeSha);
      const obj = this.read(treeSha);
      if (!obj || obj.type !== 'tree') return;
      for (const e of parseTree(obj.body)) {
        if (e.mode === '40000') addTree(e.sha);
        else if (!seen.has(e.sha)) { seen.add(e.sha); ids.push(e.sha); }
      }
    };

    const walk = (sha: string, level: number): void => {
      if (seen.has(sha)) return;
      const obj = this.read(sha);
      if (obj && obj.type === 'tag') {
        seen.add(sha);
        ids.push(sha);
        const target = obj.body.toString('utf8').split('\n').find((l) => l.startsWith('object '));
        if (target) walk(target.slice(7).trim(), level);
        return;
      }
      const commit = this.commitBody(sha);
      if (!commit) return;
      seen.add(sha);
      ids.push(sha);
      addTree(commit.tree);
      if (depth !== null && level + 1 >= depth) {
        if (commit.parents.length > 0) shallow.push(sha);
        return;
      }
      for (const p of commit.parents) walk(p, level + 1);
    };

    for (const t of tips) walk(t, 0);
    return { ids, shallow };
  }

  issueList(repoId: number): Issue[] {
    return this.issues.get(repoId) ?? [];
  }

  /** One issue by its number: indexed on the first miss, so a warm read finds it at once. */
  issueByNumber(repoId: number, number: number, includePulls = false): Issue | null {
    const index = this.issueIndex.get(repoId);
    if (index) {
      const hit = index.get(number);
      if (hit && (includePulls || !hit.isPull)) return hit;
    }
    const list = this.issueList(repoId);
    for (const issue of list) {
      if (issue.number === number && (includePulls || !issue.isPull)) {
        if (index) index.set(number, issue);
        return issue;
      }
    }
    return null;
  }

  pullList(repoId: number): Pull[] {
    return this.pulls.get(repoId) ?? [];
  }

  labelList(repoId: number): Label[] {
    return this.labels.get(repoId) ?? [];
  }
}
