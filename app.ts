// The HTTP surface: git smart HTTP, REST v3, GraphQL and MCP on one server.
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse, Server } from 'node:http';

import { advertiseInfoRefs, receivePack, uploadPackV0, uploadPackV2 } from './src/githttp.ts';
import { handleRest } from './src/rest.ts';
import type { Ctx } from './src/rest.ts';
import { handleGraphql } from './src/graphql.ts';
import { handleMcp } from './src/mcp.ts';
import { Store } from './src/store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > 256 * 1024 * 1024) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(chunks.length === 1 ? chunks[0] : Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** A method whose request may carry a body; everything else skips the body reader. */
function mayHaveBody(req: IncomingMessage): boolean {
  const method = req.method ?? 'GET';
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return false;
  if (req.headers['transfer-encoding'] !== undefined) return true;
  const length = req.headers['content-length'];
  return length !== undefined && length !== '0';
}

function tokenOf(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (!header) return null;
  const m = /^(?:Bearer|token)\s+(.+)$/i.exec(header.trim());
  return m ? m[1].trim() : null;
}

/** Query parameters, decoded only when a route asks for one. */
class LazyQuery {
  private map: URLSearchParams | null = null;
  private readonly search: string;
  constructor(search: string) {
    this.search = search;
  }
  get(name: string): string | null {
    if (this.map === null) this.map = new URLSearchParams(this.search);
    return this.map.get(name);
  }
  entries(): IterableIterator<[string, string]> {
    if (this.map === null) this.map = new URLSearchParams(this.search);
    return this.map.entries();
  }
}

const SLASH = 0x2f;

function splitPath(target: string): { path: string; search: string } {
  const q = target.indexOf('?');
  const raw = q === -1 ? target : target.slice(0, q);
  const search = q === -1 ? '' : target.slice(q + 1);
  const path = raw.indexOf('%') === -1 ? raw : decodeURI(raw);
  return { path, search };
}

export interface AppOptions { now?: string; login?: string; token?: string }

export function createApp(options: AppOptions = {}): { server: Server; store: Store } {
  const store = new Store(options.now);
  const login = options.login ?? process.env.MAKEFUN_SHOP_LOGIN ?? 'adaiversen';
  const defaultToken = options.token ?? process.env.MAKEFUN_SHOP_TOKEN ?? 'makefun-token';
  store.addUser(login, defaultToken);

  // A request id in GitHub's shape, from a counter: cheaper than a v4 UUID per request.
  const runId = Math.floor(Math.random() * 0xffff_ffff).toString(16).padStart(8, '0');
  let requestSeq = 0;
  const nextRequestId = (): string => {
    requestSeq = (requestSeq + 1) >>> 0;
    return `${runId}-${requestSeq.toString(16).padStart(8, '0')}`;
  };

  const server = createServer((req, res) => {
    void handle(req, res);
  });
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 70_000;

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const requestId = nextRequestId();
    const { path, search } = splitPath(req.url ?? '/');
    let body: Buffer;
    if (mayHaveBody(req)) {
      try {
        body = await readBody(req);
      } catch {
        res.writeHead(413, { 'content-type': JSON_TYPE, 'x-github-request-id': requestId });
        res.end(JSON.stringify({ message: 'Request body too large' }));
        return;
      }
    } else {
      body = EMPTY;
    }

    const send = (status: number, payload: Buffer | string, headers: Record<string, string> = {}): void => {
      const buf = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
      res.writeHead(status, {
        'content-type': JSON_TYPE,
        'x-github-request-id': requestId,
        'content-length': String(buf.length),
        ...headers,
      });
      res.end(buf);
    };

    const token = tokenOf(req);
    const user = token ? (store.userByToken(token) ?? store.userByToken(defaultToken) ?? null) : null;

    const ctx: Ctx = {
      store,
      user,
      method: req.method ?? 'GET',
      path,
      query: new LazyQuery(search) as unknown as Ctx['query'],
      body: null,
      base: `http://${req.headers.host ?? 'localhost'}`,
      json: (status, payload, headers) => send(status, JSON.stringify(payload), headers),
      text: (status, payload, headers) => send(status, payload, headers),
      raw: (status, payload, contentType, headers) => {
        const buf = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload as Buffer;
        res.writeHead(status, { 'content-type': contentType, 'x-github-request-id': requestId, 'content-length': String(buf.length), ...headers });
        res.end(buf);
      },
    } as Ctx;

    // raw binary routes first: git smart HTTP
    const gitMatch = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(path);
    if (gitMatch) {
      const [, owner, repoName, restRaw] = gitMatch;
      const repo = store.repo(owner, repoName);
      const rest = restRaw ?? '';
      if (!repo) {
        send(404, JSON.stringify({ message: 'Not Found' }));
        return;
      }
      if (rest === '/info/refs' || rest.startsWith('/info/refs')) {
        const service = search.indexOf('service=') === -1
          ? ''
          : new URLSearchParams(search).get('service') ?? '';
        if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
          send(400, JSON.stringify({ message: 'Unsupported service' }));
          return;
        }
        const protocol = String(req.headers['git-protocol'] ?? '');
        const v2 = service === 'git-upload-pack' && protocol.includes('version=2');
        const payload = advertiseInfoRefs(repo, service, v2);
        res.writeHead(200, {
          'content-type': `application/x-${service}-advertisement`,
          'cache-control': 'no-cache',
          'x-github-request-id': requestId,
          'content-length': String(payload.length),
        });
        res.end(payload);
        return;
      }
      if (rest === '/git-upload-pack' && req.method === 'POST') {
        const protocol = String(req.headers['git-protocol'] ?? '');
        const payload = protocol.includes('version=2')
          ? await uploadPackV2(store, repo, body)
          : uploadPackV0(store, repo, body);
        res.writeHead(200, {
          'content-type': 'application/x-git-upload-pack-result',
          'cache-control': 'no-cache',
          'x-github-request-id': requestId,
          'content-length': String(payload.length),
        });
        res.end(payload);
        return;
      }
      if (rest === '/git-receive-pack' && req.method === 'POST') {
        const payload = receivePack(store, repo, body);
        res.writeHead(200, {
          'content-type': 'application/x-git-receive-pack-result',
          'cache-control': 'no-cache',
          'x-github-request-id': requestId,
          'content-length': String(payload.length),
        });
        res.end(payload);
        return;
      }
      send(404, JSON.stringify({ message: 'Not Found' }));
      return;
    }

    if (path === '/healthz') {
      send(200, HEALTH);
      return;
    }

    if (path === '/api/graphql' || path === '/graphql') {
      try {
        ctx.body = body.length ? JSON.parse(body.toString('utf8')) : {};
      } catch {
        send(400, JSON.stringify({ message: 'Problems parsing JSON' }));
        return;
      }
      handleGraphql(ctx);
      return;
    }

    if (path === '/mcp') {
      if (req.method === 'GET') { send(405, JSON.stringify({ message: 'Method Not Allowed' })); return; }
      try {
        ctx.body = body.length ? JSON.parse(body.toString('utf8')) : null;
      } catch {
        send(400, JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
        return;
      }
      handleMcp(ctx);
      return;
    }

    if (path.startsWith('/api/v3')) {
      if (body.length && (req.method === 'POST' || req.method === 'PATCH' || req.method === 'PUT' || req.method === 'DELETE')) {
        try {
          ctx.body = JSON.parse(body.toString('utf8'));
        } catch {
          send(400, JSON.stringify({ message: 'Problems parsing JSON' }));
          return;
        }
      }
      if (handleRest(ctx)) return;
      send(404, JSON.stringify({ message: 'Not Found' }));
      return;
    }

    send(404, JSON.stringify({ message: 'Not Found' }));
  };

  return { server, store };
}

const EMPTY = Buffer.alloc(0);
const HEALTH = Buffer.from('{"ok":true}', 'utf8');
