// Local smoke test: exercises the four surfaces without the harness.
//   node --experimental-strip-types tools/smoke.ts
import { createApp } from '../app.ts';

const TOKEN = 'smoke-token';
const { server } = createApp({ login: 'makefun', token: TOKEN });

const listen = (): Promise<number> => new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => {
    const addr = server.address();
    resolve(typeof addr === 'object' && addr ? addr.port : 0);
  });
});

async function call(port: number, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, text, json };
}

const port = await listen();
const log: string[] = [];
const check = (name: string, ok: boolean, extra = ''): void => {
  log.push(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ` (${extra})` : ''}`);
};

const meta = await call(port, 'GET', '/api/v3/');
check('GET /api/v3/', meta.status === 200);

const created = await call(port, 'POST', '/api/v3/user/repos', { name: 'demo', description: 'first', auto_init: true });
check('POST /user/repos', created.status === 201, String(created.status));

const repo = await call(port, 'GET', '/api/v3/repos/makefun/demo');
check('GET /repos/{owner}/{repo}', repo.status === 200);

const patched = await call(port, 'PATCH', '/api/v3/repos/makefun/demo', { description: 'second' });
check('PATCH repo', patched.status === 200 && (patched.json as { description?: string })?.description === 'second');

const content = await call(port, 'PUT', '/api/v3/repos/makefun/demo/contents/notes.txt',
  { message: 'add notes', content: Buffer.from('hello\n').toString('base64') });
check('PUT contents create', content.status === 201, String(content.status));

const read = await call(port, 'GET', '/api/v3/repos/makefun/demo/contents/notes.txt');
check('GET contents', read.status === 200, String(read.status));

const label = await call(port, 'POST', '/api/v3/repos/makefun/demo/labels', { name: 'bug', color: 'ff0000' });
check('POST label', label.status === 201);

const issue = await call(port, 'POST', '/api/v3/repos/makefun/demo/issues', { title: 'Broken', body: 'x' });
check('POST issue', issue.status === 201, String(issue.status));
const issueNum = (issue.json as { number?: number })?.number ?? 0;

const badLabel = await call(port, 'POST', '/api/v3/repos/makefun/demo/issues', { title: 'x', labels: ['nope'] });
check('POST issue unknown label 422', badLabel.status === 422);

const readIssue = await call(port, 'GET', `/api/v3/repos/makefun/demo/issues/${issueNum}`);
check('GET issue', readIssue.status === 200);

const missing = await call(port, 'GET', '/api/v3/nope');
check('unknown route 404 json', missing.status === 404 && typeof (missing.json as { message?: string })?.message === 'string');

const gql = await call(port, 'POST', '/api/graphql', {
  query: 'query($o:String!,$n:String!){repository(owner:$o,name:$n){nameWithOwner issues(first:5,states:[OPEN]){totalCount nodes{number title state}}}}',
  variables: { o: 'makefun', n: 'demo' },
});
check('graphql repository.issues', gql.status === 200 && (gql.json as { data?: unknown })?.data !== undefined, gql.text.slice(0, 120));

const gqlType = await call(port, 'POST', '/api/graphql', { query: '{__type(name:"Repository"){name fields{name}}}' });
check('graphql __type', gqlType.status === 200 && gqlType.text.includes('nameWithOwner'));

const mcpList = await call(port, 'POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { 'mcp-protocol-version': '2026-07-28' });
const mcpList2 = await call(port, 'POST', '/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/list' }, { 'mcp-protocol-version': '2026-07-28' });
check('mcp tools/list stable', mcpList.status === 200 && mcpList.text.replace(/"id":1/, '"id":2') === mcpList2.text);

const mcpCreate = await call(port, 'POST', '/mcp', {
  jsonrpc: '2.0', id: 3, method: 'tools/call',
  params: { name: 'create_issue', arguments: { owner: 'makefun', repo: 'demo', title: 'From MCP' } },
}, { 'mcp-protocol-version': '2026-07-28' });
check('mcp create_issue', mcpCreate.status === 200 && !mcpCreate.text.includes('"isError":true'), mcpCreate.text.slice(0, 120));

const unauth = await fetch(`http://127.0.0.1:${port}/api/v3/user`);
check('no auth 401', unauth.status === 401);

const malformed = await fetch(`http://127.0.0.1:${port}/api/v3/user/repos`, {
  method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: '{oops',
});
check('malformed json 400', malformed.status === 400);

console.log(log.join('\n'));
const failed = log.filter((l) => l.startsWith('FAIL')).length;
console.log(`\n${log.length - failed}/${log.length} passed`);
server.close();
process.exit(failed ? 1 : 0);
