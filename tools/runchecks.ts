// Runs the kit env's own checks against a local forge, so failures can be read
// without a full graded trial.
//   node --experimental-strip-types tools/runchecks.ts [groups...]
import { createApp } from '../app.ts';
import { buildScenario } from '/home/ubuntu/makefun/kit-forge/github-core-clone-01-kit/program/env/src/wire.ts';
import { restChecks, restProtocolChecks } from '/home/ubuntu/makefun/kit-forge/github-core-clone-01-kit/program/env/src/checks-rest.ts';
import { GIT_CHECKS } from '/home/ubuntu/makefun/kit-forge/github-core-clone-01-kit/program/env/src/checks-git.ts';
import { MCP_CHECKS } from '/home/ubuntu/makefun/kit-forge/github-core-clone-01-kit/program/env/src/checks-mcp.ts';
import { GRAPHQL_CHECKS, configureGraphQLGit } from '/home/ubuntu/makefun/kit-forge/github-core-clone-01-kit/program/env/src/checks-graphql.ts';
import { createGitFixture } from '/home/ubuntu/makefun/kit-forge/github-core-clone-01-kit/program/env/src/main.ts';
import type { CheckContext, CheckSpec } from '/home/ubuntu/makefun/kit-forge/github-core-clone-01-kit/program/env/src/manifest.ts';

const TOKEN = 'check-token';
const { server } = createApp({ token: TOKEN, now: '2026-11-18T00:00:00Z' });
const port: number = await new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => {
    const addr = server.address();
    resolve(typeof addr === 'object' && addr ? addr.port : 0);
  });
});
const base = `http://127.0.0.1:${port}`;

const scenario = buildScenario();
configureGraphQLGit(createGitFixture({
  baseUrl: base,
  token: TOKEN,
  signal: new AbortController().signal,
  log: () => {},
}));

const groups = process.argv.slice(2);
const all: CheckSpec[] = [...restChecks(), ...restProtocolChecks(), ...GIT_CHECKS, ...MCP_CHECKS, ...GRAPHQL_CHECKS];
const selected = groups.length ? all.filter((c) => groups.includes(String(c.id).split('.')[0])) : all;

let pass = 0;
for (const spec of selected) {
  const ctx: CheckContext = {
    baseUrl: base,
    token: TOKEN,
    scenario,
    signal: new AbortController().signal,
    deadlineMs: Date.now() + 30_000,
    timeoutMs: 25_000,
    log: (m: string) => { if (process.env.VERBOSE) console.log(`   log: ${m}`); },
  };
  try {
    const res = await spec.fn(ctx);
    const ok = (res as { ok?: boolean }).ok ?? (res as { passed?: boolean }).passed ?? false;
    const detail = (res as { detail?: string }).detail ?? '';
    console.log(`${ok ? 'PASS' : 'FAIL'} ${spec.id} — ${detail}`.slice(0, 240));
    if (ok) pass++;
  } catch (e) {
    console.log(`FAIL ${spec.id} — threw: ${(e as Error).message}`.slice(0, 240));
  }
}
console.log(`\n${pass}/${selected.length} passed`);
server.close();
process.exit(0);
