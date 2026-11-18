// Pushes a real repository (with an annotated tag) into a local forge and reads
// ls-refs back, to debug the tag peels the suite expects.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../app.ts';

const TOKEN = 'tag-token';
const { server } = createApp({ token: TOKEN, now: '2026-11-18T00:00:00Z' });
const port: number = await new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => {
    const addr = server.address();
    resolve(typeof addr === 'object' && addr ? addr.port : 0);
  });
});
const base = `http://127.0.0.1:${port}`;

const create = await fetch(`${base}/api/v3/user/repos`, {
  method: 'POST',
  headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'tagdemo', private: true, description: 'tags' }),
});
console.log('create repo', create.status);

const dir = mkdtempSync(join(tmpdir(), 'forge-tag-'));
const git = (...args: string[]): string => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
git('init', '-q');
git('config', 'user.email', 'adaiversen@example.invalid');
git('config', 'user.name', 'ada iversen');
writeFileSync(join(dir, 'a.txt'), 'hello\n');
git('add', '.');
git('commit', '-q', '-m', 'first commit');
git('tag', '-a', 'v1', '-m', 'release one');

const remote = `${base}/adaiversen/tagdemo.git`;
const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
try {
  execFileSync('git', ['push', '--tags', remote, 'HEAD:refs/heads/main'], {
    cwd: dir, encoding: 'utf8', env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  console.log('push ok');
} catch (e) {
  console.log('push failed:', (e as { stderr?: string }).stderr ?? (e as Error).message);
}

const lsrefs = await fetch(`${base}/adaiversen/tagdemo.git/git-upload-pack`, {
  method: 'POST',
  headers: {
    authorization: `Bearer ${TOKEN}`,
    'content-type': 'application/x-git-upload-pack-request',
    'git-protocol': 'version=2',
  },
  body: Buffer.concat([
    Buffer.from('0014command=ls-refs\n'),
    Buffer.from('0001'),
    Buffer.from('0009peel\n'),
    Buffer.from('000b symrefs\n'),
    Buffer.from('0000'),
  ]),
});
const text = Buffer.from(await lsrefs.arrayBuffer()).toString('utf8');
console.log('--- ls-refs raw ---');
console.log(JSON.stringify(text));

server.close();
process.exit(0);
