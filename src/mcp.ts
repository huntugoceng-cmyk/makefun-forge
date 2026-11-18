// Model Context Protocol over streamable HTTP: discover/initialize, tools/list and
// tools/call, acting on the same store REST reads.
import type { Ctx } from './rest.ts';
import { createIssue, createPull, mergePull, repoJson } from './rest.ts';

export const PROTOCOL_REVISIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26'];

interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  props?: string[];
}

const s = (description: string): Record<string, unknown> => ({ type: 'string', description });

export const TOOLS: Tool[] = [
  {
    name: 'create_repo',
    description: 'Create a repository for the authenticated user.',
    props: ['name', 'description', 'private'],
    inputSchema: {
      type: 'object',
      properties: { name: s('The repository name.'), description: s('A short description.'), private: { type: 'boolean', description: 'Whether the repository is private.' } },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get one repository by owner and name.',
    props: ['owner', 'repo', 'full_name'],
    inputSchema: {
      type: 'object',
      properties: { owner: s('The account owner.'), repo: s('The repository name.'), full_name: s('owner/repo.') },
      required: [],
    },
  },
  {
    name: 'create_issue',
    description: 'Open an issue on a repository.',
    props: ['owner', 'repo', 'full_name', 'title', 'body'],
    inputSchema: {
      type: 'object',
      properties: { owner: s('The account owner.'), repo: s('The repository name.'), full_name: s('owner/repo.'), title: s('The issue title.'), body: s('The issue body.') },
      required: ['title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    props: ['owner', 'repo', 'full_name', 'state'],
    inputSchema: {
      type: 'object',
      properties: { owner: s('The account owner.'), repo: s('The repository name.'), full_name: s('owner/repo.'), state: s('open, closed or all.') },
      required: [],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a pushed head branch into a base branch.',
    props: ['owner', 'repo', 'full_name', 'title', 'head', 'base', 'body'],
    inputSchema: {
      type: 'object',
      properties: { owner: s('The account owner.'), repo: s('The repository name.'), full_name: s('owner/repo.'), title: s('The pull request title.'), head: s('The head branch.'), base: s('The base branch.'), body: s('The pull request body.') },
      required: ['title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request into its base branch.',
    props: ['owner', 'repo', 'full_name', 'pull_number', 'merge_method'],
    inputSchema: {
      type: 'object',
      properties: { owner: s('The account owner.'), repo: s('The repository name.'), full_name: s('owner/repo.'), pull_number: { type: 'number', description: 'The pull request number.' }, merge_method: s('merge, squash or rebase.') },
      required: ['pull_number'],
    },
  },
];

const TOOLS_JSON = JSON.stringify(TOOLS.map((t) => ({
  name: t.name,
  description: t.description,
  inputSchema: t.inputSchema,
})));

interface Rpc { jsonrpc?: string; id?: unknown; method?: string; params?: Record<string, unknown> }

function ok(id: unknown, result: unknown) {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function err(id: unknown, code: number, message: string) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function textResult(payload: unknown, isError = false) {
  return {
    content: [{ type: 'text', text: typeof payload === 'string' ? payload : JSON.stringify(payload) }],
    isError,
  };
}

/** Fills owner/repo from full_name or a namespaced property, as the client sends them. */
function repoArgs(args: Record<string, unknown>): { owner: string; repo: string } {
  let owner = typeof args.owner === 'string' ? args.owner : '';
  let repo = typeof args.repo === 'string' ? args.repo : '';
  if ((!owner || !repo) && typeof args.full_name === 'string' && args.full_name.includes('/')) {
    const [o, r] = args.full_name.split('/');
    owner = owner || o;
    repo = repo || r;
  }
  return { owner, repo };
}

export function handleMcp(ctx: Ctx): void {
  if (!ctx.user) { ctx.json(401, { message: 'Requires authentication' }); return; }
  if (!ctx.body || typeof ctx.body !== 'object') {
    ctx.json(400, err(null, -32700, 'Parse error'));
    return;
  }
  const rpc = ctx.body as Rpc;
  const method = rpc.method ?? '';
  const id = rpc.id;

  if (method === 'notifications/initialized' || method === 'notifications/cancelled') {
    ctx.text(202, '');
    return;
  }
  if (method === 'initialize') {
    const requested = String((rpc.params as Record<string, unknown> | undefined)?.protocolVersion ?? PROTOCOL_REVISIONS[1]);
    ctx.json(200, ok(id, {
      protocolVersion: PROTOCOL_REVISIONS.includes(requested) ? requested : PROTOCOL_REVISIONS[1],
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'makefun-forge', version: '1.0.0' },
    }), { 'mcp-session-id': 'makefun-session' });
    return;
  }
  if (method === 'server/discover') {
    ctx.json(200, ok(id, {
      supportedVersions: PROTOCOL_REVISIONS,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'makefun-forge', version: '1.0.0' },
      protocolVersion: PROTOCOL_REVISIONS[0],
    }));
    return;
  }
  if (method === 'ping') { ctx.json(200, ok(id, {})); return; }
  if (method === 'tools/list') {
    // byte-identical across calls: one pre-rendered body
    ctx.raw(200, `{"jsonrpc":"2.0","id":${JSON.stringify(id ?? null)},"result":{"tools":${TOOLS_JSON}}}`, 'application/json');
    return;
  }
  if (method === 'tools/call') {
    const params = (rpc.params ?? {}) as Record<string, unknown>;
    const rawName = String(params.name ?? '');
    const name = rawName.toLowerCase().replace(/^.*__/, '');
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) { ctx.json(200, err(id, -32602, `Unknown tool: ${rawName}`)); return; }
    const missing = (tool.inputSchema.required as string[]).filter((r) => args[r] === undefined || args[r] === null);
    if (missing.length) {
      ctx.json(200, ok(id, textResult(`Missing required argument: ${missing.join(', ')}`, true)));
      return;
    }
    const store = ctx.store;
    const me = ctx.user;
    try {
      if (name === 'create_repo') {
        const repoName = String(args.name ?? '');
        if (!repoName) { ctx.json(200, ok(id, textResult('name is required', true))); return; }
        const existing = store.repo(me.login, repoName);
        const repo = existing ?? store.createRepo(me.login, repoName, {
          description: typeof args.description === 'string' ? args.description : '',
          private: args.private === true,
        });
        ctx.json(200, ok(id, textResult(repoJson(ctx, repo))));
        return;
      }
      if (name === 'get_repo') {
        const { owner, repo } = repoArgs(args);
        const found = owner && repo ? store.repo(owner, repo) : null;
        if (!found) { ctx.json(200, ok(id, textResult('Repository not found', true))); return; }
        ctx.json(200, ok(id, textResult(repoJson(ctx, found))));
        return;
      }
      if (name === 'create_issue') {
        const { owner, repo } = repoArgs(args);
        const found = store.repo(owner, repo);
        if (!found) { ctx.json(200, ok(id, textResult('Repository not found', true))); return; }
        const issue = createIssue(store, found, String(args.title ?? ''), String(args.body ?? ''), me.login);
        ctx.json(200, ok(id, textResult({ id: issue.id, number: issue.number, title: issue.title, state: issue.state, body: issue.body })));
        return;
      }
      if (name === 'list_issues') {
        const { owner, repo } = repoArgs(args);
        const found = store.repo(owner, repo);
        if (!found) { ctx.json(200, ok(id, textResult('Repository not found', true))); return; }
        const state = typeof args.state === 'string' ? args.state : 'open';
        const list = store.issueList(found.id)
          .filter((i) => !i.isPull && (state === 'all' || i.state === state))
          .map((i) => ({ id: i.id, number: i.number, title: i.title, state: i.state, body: i.body }));
        ctx.json(200, ok(id, textResult(list)));
        return;
      }
      if (name === 'create_pull_request') {
        const { owner, repo } = repoArgs(args);
        const found = store.repo(owner, repo);
        if (!found) { ctx.json(200, ok(id, textResult('Repository not found', true))); return; }
        const pull = createPull(store, found, String(args.title ?? ''), String(args.head ?? ''),
          String(args.base ?? ''), me.login, String(args.body ?? ''));
        ctx.json(200, ok(id, textResult({ id: pull.id, number: pull.number, title: pull.title, head: pull.head, base: pull.base, state: pull.state })));
        return;
      }
      if (name === 'merge_pull_request') {
        const { owner, repo } = repoArgs(args);
        const found = store.repo(owner, repo);
        if (!found) { ctx.json(200, ok(id, textResult('Repository not found', true))); return; }
        const num = Number(args.pull_number ?? args.number ?? 0);
        const pull = store.pullList(found.id).find((p) => p.number === num);
        if (!pull) { ctx.json(200, ok(id, textResult('Pull request not found', true))); return; }
        const method = typeof args.merge_method === 'string' ? args.merge_method : 'merge';
        const result = mergePull(ctx, found, pull, method);
        if (result.status !== 200) {
          ctx.json(200, ok(id, textResult(JSON.stringify(result.body), true)));
          return;
        }
        ctx.json(200, ok(id, textResult(result.body)));
        return;
      }
    } catch (e) {
      ctx.json(200, ok(id, textResult(`Tool failed: ${(e as Error).message}`, true)));
      return;
    }
  }
  ctx.json(200, err(id, -32601, `Method not found: ${method}`));
}
