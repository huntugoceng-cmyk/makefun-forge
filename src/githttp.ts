// git smart HTTP: pkt-line framing, protocol v2 upload-pack (ls-refs, fetch)
// and v0 receive-pack with fast-forward checks.
import { parseTree, readPack, writePack } from './git.ts';
import type { Store, Repo } from './store.ts';

export const FLUSH = Buffer.from('0000', 'ascii');
export const DELIM = Buffer.from('0001', 'ascii');

export function pkt(data: string | Buffer): Buffer {
  const body = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const header = Buffer.from((body.length + 4).toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, body]);
}

export function sideband(channel: number, data: Buffer): Buffer {
  return pkt(Buffer.concat([Buffer.from([channel]), data]));
}

interface Packet { data: Buffer | null; type: 'data' | 'flush' | 'delim' }

export function parsePackets(buf: Buffer): { packets: Packet[]; rest: Buffer } {
  const packets: Packet[] = [];
  let p = 0;
  while (p + 4 <= buf.length) {
    const lenHex = buf.subarray(p, p + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(lenHex)) break;
    const len = parseInt(lenHex, 16);
    if (len === 0) { packets.push({ data: null, type: 'flush' }); p += 4; continue; }
    if (len === 1) { packets.push({ data: null, type: 'delim' }); p += 4; continue; }
    if (len < 4 || p + len > buf.length) break;
    packets.push({ data: buf.subarray(p + 4, p + len), type: 'data' });
    p += len;
  }
  return { packets, rest: buf.subarray(p) };
}

const CAPS_UPLOAD_V0 = 'multi_ack_detailed side-band-64k thin-pack ofs-delta shallow no-progress include-tag agent=makefun-forge/1.0';
const CAPS_RECEIVE = 'report-status side-band-64k delete-refs object-format=sha1 agent=makefun-forge/1.0';

function refList(repo: Repo): [string, string][] {
  const out: [string, string][] = [];
  for (const [ref, sha] of repo.refs) out.push([sha, ref]);
  out.sort((a, b) => (a[1] < b[1] ? -1 : 1));
  return out;
}

export function advertiseInfoRefs(repo: Repo, service: string, version2: boolean): Buffer {
  if (service === 'git-upload-pack' && version2) {
    return Buffer.concat([
      pkt('version 2\n'),
      pkt('agent=makefun-forge/1.0\n'),
      pkt('ls-refs=unborn\n'),
      pkt('fetch=shallow wait-for-done\n'),
      pkt('object-format=sha1\n'),
      FLUSH,
    ]);
  }
  const preamble = Buffer.concat([pkt(`# service=${service}\n`), FLUSH]);
  const refs = refList(repo);
  const head = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? (refs[0]?.[0] ?? null);
  const chunks: Buffer[] = [preamble];
  if (refs.length === 0) {
    const zero = '0'.repeat(40);
    if (service === 'git-upload-pack') {
      chunks.push(pkt(`${zero} capabilities^{}\0${CAPS_UPLOAD_V0}\n`));
    } else {
      chunks.push(pkt(`${zero} capabilities^{}\0${CAPS_RECEIVE}\n`));
    }
    chunks.push(FLUSH);
    return Buffer.concat(chunks);
  }
  const caps = service === 'git-upload-pack' ? CAPS_UPLOAD_V0 : CAPS_RECEIVE;
  if (head) chunks.push(pkt(`${head} HEAD\0${caps}\n`));
  let first = !head;
  for (const [sha, ref] of refs) {
    if (first) {
      chunks.push(pkt(`${sha} ${ref}\0${caps}\n`));
      first = false;
    } else {
      chunks.push(pkt(`${sha} ${ref}\n`));
    }
  }
  chunks.push(FLUSH);
  return Buffer.concat(chunks);
}

/** Packfiles for a clone of the same tips are identical: keep the last few, and
 *  share one build between requests that arrive together. */
const PACK_CACHE = new Map<string, Promise<Buffer>>();
const PACK_CACHE_MAX = 24;

function cachedPack(store: Store, repo: Repo, ids: string[]): Promise<Buffer> {
  const key = `${repo.id}|${ids.length}|${ids[0] ?? ''}|${ids[ids.length - 1] ?? ''}`;
  const hit = PACK_CACHE.get(key);
  if (hit) return hit;
  const pending = Promise.resolve().then(() => writePack(ids, (sha) => store.read(sha)));
  if (PACK_CACHE.size >= PACK_CACHE_MAX) {
    const first = PACK_CACHE.keys().next().value;
    if (first !== undefined) PACK_CACHE.delete(first);
  }
  PACK_CACHE.set(key, pending);
  return pending;
}


export async function uploadPackV2(store: Store, repo: Repo, body: Buffer): Promise<Buffer> {
  const { packets } = parsePackets(body);
  let command = '';
  const args: string[] = [];
  for (const p of packets) {
    if (p.type !== 'data' || !p.data) continue;
    const line = p.data.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('command=')) command = line.slice(8);
    else if (line) args.push(line);
  }

  if (command === 'ls-refs') {
    const out: Buffer[] = [];
    const symrefs = args.includes('symrefs');
    const peel = args.includes('peel');
    const prefixes = args.filter((a) => a.startsWith('ref-prefix ')).map((a) => a.slice(11).trim());
    const wanted = (ref: string): boolean =>
      prefixes.length === 0 || prefixes.some((p) => ref.startsWith(p));
    const head = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    if (head && wanted('HEAD')) {
      const extra = symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : '';
      out.push(pkt(`${head} HEAD${extra}\n`));
    }
    for (const [sha, ref] of refList(repo)) {
      if (!wanted(ref)) continue;
      let attrs = '';
      if (peel) {
        const obj = store.read(sha);
        if (obj && obj.type === 'tag') {
          const target = obj.body.toString('utf8').split('\n').find((l) => l.startsWith('object '));
          if (target) attrs += ` peeled:${target.slice(7).trim()}`;
        }
      }
      out.push(pkt(`${sha} ${ref}${attrs}\n`));
    }
    out.push(FLUSH);
    return Buffer.concat(out);
  }

  if (command === 'fetch') {
    const rawWants = args.filter((a) => a.startsWith('want ')).map((a) => a.slice(5).trim());
    const haves = args.filter((a) => a.startsWith('have ')).map((a) => a.slice(5).trim());
    let depth: number | null = null;
    for (const a of args) {
      const m = /^deepen (\d+)$/.exec(a);
      if (m) depth = Number(m[1]);
    }

    const tagIds: string[] = [];
    const tips: string[] = [];
    for (const want of rawWants) {
      const obj = store.read(want);
      if (obj && obj.type === 'tag') {
        tagIds.push(want);
        const target = obj.body.toString('utf8').split('\n').find((l) => l.startsWith('object '));
        if (target) tips.push(target.slice(7).trim());
        else tips.push(want);
      } else {
        tips.push(want);
      }
    }

    const { ids, shallow } = store.reachable(repo, tips, depth);
    const clientShallow = args.filter((a) => a.startsWith('shallow ')).map((a) => a.slice(8).trim());
    const extraIds: string[] = [];
    const newShallow: string[] = [];
    const unshallow: string[] = [];
    if (clientShallow.length > 0 && depth !== null) {
      const seenIds = new Set(ids);
      const addTreeOf = (treeSha: string): void => {
        const stack = [treeSha];
        while (stack.length) {
          const cur = stack.pop()!;
          if (seenIds.has(cur)) continue;
          seenIds.add(cur);
          extraIds.push(cur);
          const obj = store.read(cur);
          if (!obj || obj.type !== 'tree') continue;
          for (const e of parseTree(obj.body)) {
            if (e.mode === '40000') stack.push(e.sha);
            else if (!seenIds.has(e.sha)) { seenIds.add(e.sha); extraIds.push(e.sha); }
          }
        }
      };
      const walkDown = (sha: string, level: number): void => {
        const commit = store.commitBody(sha);
        if (!commit) return;
        unshallow.push(sha);
        addTreeOf(commit.tree);
        if (level + 1 >= depth) {
          if (commit.parents.length > 0) newShallow.push(sha);
          return;
        }
        for (const p of commit.parents) walkDown(p, level + 1);
      };
      for (const s of clientShallow) walkDown(s, 0);
    }
    const deepening = clientShallow.length > 0 && depth !== null;
    const held = new Set<string>(!deepening && haves.length ? store.reachable(repo, haves, null).ids : []);
    const fresh = [...ids, ...extraIds].filter((id) => !held.has(id));
    const payloadIds = [...tagIds.filter((id) => !held.has(id)), ...fresh];
    const out: Buffer[] = [];
    if (shallow.length > 0 || newShallow.length > 0 || unshallow.length > 0) {
      out.push(pkt('shallow-info\n'));
      for (const sha of unshallow) out.push(pkt(`unshallow ${sha}\n`));
      for (const sha of [...shallow, ...newShallow]) out.push(pkt(`shallow ${sha}\n`));
      out.push(DELIM);
    }
    out.push(pkt('packfile\n'));
    const pack = await cachedPack(store, repo, payloadIds);
    const CHUNK = 48 * 1024;
    for (let i = 0; i < pack.length; i += CHUNK) out.push(sideband(1, pack.subarray(i, i + CHUNK)));
    out.push(FLUSH);
    return Buffer.concat(out);
  }

  return Buffer.concat([FLUSH]);
}

/** Protocol v0 upload-pack, used when the client does not ask for v2. */
export function uploadPackV0(store: Store, repo: Repo, body: Buffer): Buffer {
  const { packets } = parsePackets(body);
  const wants: string[] = [];
  let done = false;
  for (const p of packets) {
    if (p.type !== 'data' || !p.data) continue;
    const line = p.data.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) wants.push(line.slice(5, 45).trim());
    if (line === 'done') done = true;
  }
  if (!done) return Buffer.concat([pkt('NAK\n')]);
  const { ids } = store.reachable(repo, wants, null);
  const pack = writePack(ids, (sha) => store.read(sha));
  const out: Buffer[] = [pkt('NAK\n')];
  const CHUNK = 48 * 1024;
  for (let i = 0; i < pack.length; i += CHUNK) out.push(sideband(1, pack.subarray(i, i + CHUNK)));
  out.push(FLUSH);
  return Buffer.concat(out);
}

function isAncestor(store: Store, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === ancestor) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const commit = store.commitBody(cur);
    if (commit) for (const p of commit.parents) stack.push(p);
  }
  return false;
}

const ZERO = '0'.repeat(40);

export function receivePack(store: Store, repo: Repo, body: Buffer): Buffer {
  const { packets, rest } = parsePackets(body);
  const commands: { old: string; new: string; ref: string }[] = [];
  let caps = '';
  for (const p of packets) {
    if (p.type !== 'data' || !p.data) continue;
    const line = p.data.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    const main = nul === -1 ? line : line.slice(0, nul);
    if (nul !== -1) caps = line.slice(nul + 1);
    const parts = main.split(' ');
    if (parts.length < 3) continue;
    commands.push({ old: parts[0], new: parts[1], ref: parts[2] });
  }

  const wantSideband = caps.includes('side-band-64k');
  const streamed = commands.some((c) => c.new !== ZERO);
  let unpacked = 'ok';
  if (streamed && rest.length > 0) {
    try {
      const { objects } = readPack(rest);
      for (const [sha, obj] of objects) if (!store.objects.has(sha)) store.objects.set(sha, obj);
    } catch (err) {
      unpacked = `error ${(err as Error).message}`.replace(/\n/g, ' ');
    }
  }

  const report: Buffer[] = [];
  report.push(pkt(`unpack ${unpacked}\n`));
  for (const cmd of commands) {
    if (unpacked !== 'ok') {
      report.push(pkt(`ng ${cmd.ref} unpacker error\n`));
      continue;
    }
    if (cmd.new === ZERO) {
      repo.refs.delete(cmd.ref);
      report.push(pkt(`ok ${cmd.ref}\n`));
      continue;
    }
    const current = repo.refs.get(cmd.ref) ?? null;
    const expected = cmd.old === ZERO ? null : cmd.old;
    if (current !== expected) {
      report.push(pkt(`ng ${cmd.ref} non-fast-forward\n`));
      continue;
    }
    if (current && !isAncestor(store, current, cmd.new)) {
      report.push(pkt(`ng ${cmd.ref} non-fast-forward\n`));
      continue;
    }
    repo.refs.set(cmd.ref, cmd.new);
    repo.pushedAt = Date.parse(store.now());
    repo.updatedAt = Date.parse(store.now());
    report.push(pkt(`ok ${cmd.ref}\n`));
  }
  report.push(FLUSH);
  const framed = Buffer.concat(report);
  if (wantSideband) {
    const out: Buffer[] = [];
    const CHUNK = 32 * 1024;
    for (let i = 0; i < framed.length; i += CHUNK) out.push(sideband(1, framed.subarray(i, i + CHUNK)));
    out.push(FLUSH);
    return Buffer.concat(out);
  }
  return framed;
}
