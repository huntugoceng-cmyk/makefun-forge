// Git object store, refs and packfile codec: everything the forge needs to serve
// smart HTTP without a git binary.
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

const TYPE_NUM: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const NUM_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export interface Commit {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
  extra: string[];
}

export interface TreeEntry {
  mode: string;
  name: string;
  sha: string;
}

export interface PackedObject { type: ObjType; body: Buffer }

export function sha1(...parts: (string | Buffer)[]): string {
  const h = createHash('sha1');
  for (const p of parts) h.update(typeof p === 'string' ? Buffer.from(p, 'utf8') : p);
  return h.digest('hex');
}

export function objectId(type: ObjType, body: Buffer): string {
  return sha1(Buffer.from(`${type} ${body.length}\0`, 'utf8'), body);
}

export function encodeObject(type: ObjType, body: Buffer): Buffer {
  return deflateSync(Buffer.concat([Buffer.from(`${type} ${body.length}\0`, 'utf8'), body]));
}

export function decodeObject(raw: Buffer): PackedObject {
  const buf = inflateSync(raw);
  const nul = buf.indexOf(0);
  const header = buf.subarray(0, nul).toString('utf8');
  const [type, size] = header.split(' ');
  return { type: type as ObjType, body: buf.subarray(nul + 1, nul + 1 + Number(size)) };
}

export function parseCommit(body: Buffer): Commit {
  const text = body.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  const c: Commit = { tree: '', parents: [], author: '', committer: '', message, extra: [] };
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) c.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) c.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) c.author = line.slice(7);
    else if (line.startsWith('committer ')) c.committer = line.slice(10);
    else c.extra.push(line);
  }
  return c;
}

/** The parsed form of a commit body, memoised: a clone walks the same commits a lot. */
const COMMIT_CACHE = new Map<string, Commit>();

export function parseCommitCached(sha: string, body: Buffer): Commit {
  const hit = COMMIT_CACHE.get(sha);
  if (hit) return hit;
  const parsed = parseCommit(body);
  if (COMMIT_CACHE.size >= 20_000) COMMIT_CACHE.clear();
  COMMIT_CACHE.set(sha, parsed);
  return parsed;
}

export function buildCommit(c: Commit): Buffer {
  const lines = [`tree ${c.tree}`];
  for (const p of c.parents) lines.push(`parent ${p}`);
  lines.push(`author ${c.author}`, `committer ${c.committer}`);
  for (const e of c.extra ?? []) lines.push(e);
  return Buffer.from(`${lines.join('\n')}\n\n${c.message}`, 'utf8');
}

export function parseTree(body: Buffer): TreeEntry[] {
  const out: TreeEntry[] = [];
  let i = 0;
  while (i < body.length) {
    const sp = body.indexOf(0x20, i);
    if (sp === -1) break;
    const mode = body.subarray(i, sp).toString('ascii');
    const nul = body.indexOf(0, sp);
    if (nul === -1) break;
    const name = body.subarray(sp + 1, nul).toString('utf8');
    const sha = body.subarray(nul + 1, nul + 21).toString('hex');
    out.push({ mode, name, sha });
    i = nul + 21;
  }
  return out;
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const chunks: Buffer[] = [];
  for (const e of sorted) {
    chunks.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'), Buffer.from(e.sha, 'hex'));
  }
  return Buffer.concat(chunks);
}

export function flatten(
  treeSha: string,
  read: (sha: string) => PackedObject | null,
  prefix = '',
): Map<string, { sha: string; mode: string }> {
  const out = new Map<string, { sha: string; mode: string }>();
  const obj = read(treeSha);
  if (!obj || obj.type !== 'tree') return out;
  for (const e of parseTree(obj.body)) {
    const path = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.mode === '40000') {
      for (const [k, v] of flatten(e.sha, read, path)) out.set(k, v);
    } else out.set(path, { sha: e.sha, mode: e.mode });
  }
  return out;
}

/** Inflates at `start`, returning the data and how many input bytes it consumed. */
function inflateAt(buf: Buffer, start: number): { data: Buffer; used: number } {
  const info = inflateSync(buf.subarray(start), { info: true }) as unknown as
    { buffer: Buffer; engine: { bytesWritten: number } };
  return { data: info.buffer, used: info.engine.bytesWritten };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let p = 0;
  const headerSize = (): number => {
    let b = delta[p++];
    let size = b & 0x7f;
    let shift = 7;
    while (b & 0x80) { b = delta[p++]; size += (b & 0x7f) * 2 ** shift; shift += 7; }
    return size;
  };
  headerSize(); // base size
  const dstSize = headerSize();
  const out = Buffer.alloc(dstSize);
  let o = 0;
  while (p < delta.length) {
    const op = delta[p++];
    if (op & 0x80) {
      let off = 0;
      let len = 0;
      if (op & 0x01) off |= delta[p++];
      if (op & 0x02) off |= delta[p++] << 8;
      if (op & 0x04) off |= delta[p++] << 16;
      if (op & 0x08) off |= delta[p++] << 24;
      if (op & 0x10) len |= delta[p++];
      if (op & 0x20) len |= delta[p++] << 8;
      if (op & 0x40) len |= delta[p++] << 16;
      if (len === 0) len = 0x10000;
      base.copy(out, o, off, off + len);
      o += len;
    } else if (op !== 0) {
      delta.copy(out, o, p, p + op);
      o += op;
      p += op;
    } else {
      throw new Error('invalid delta opcode 0');
    }
  }
  return out.subarray(0, o);
}

/** Reads every object of a received packfile, resolving both delta kinds. */
export function readPack(pack: Buffer): { objects: Map<string, PackedObject>; order: string[] } {
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`bad pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const end = pack.length - 20;
  const objects = new Map<string, PackedObject>();
  const order: string[] = [];
  const byOffset = new Map<number, string>();
  // One view of the payload region: subarray per object would copy the cursor each time.
  const payload = pack.subarray(0, end);
  let p = 12;

  for (let n = 0; n < count; n++) {
    const at = p;
    let b = pack[p++];
    const type = (b >> 4) & 7;
    let size = b & 15;
    let shift = 4;
    while (b & 0x80) {
      b = pack[p++];
      size += (b & 0x7f) * 2 ** shift;
      shift += 7;
    }
    let body: Buffer;
    let resolvedType: ObjType | null = null;
    let payloadBytes = 0;

    if (type === 6) {
      b = pack[p++];
      let off = b & 0x7f;
      while (b & 0x80) { b = pack[p++]; off = ((off + 1) * 128) + (b & 0x7f); }
      const baseId = byOffset.get(at - off);
      if (!baseId) throw new Error(`offset delta base missing at ${at - off}`);
      const base = objects.get(baseId)!;
      const inf = inflateAt(payload, p);
      p += inf.used;
      payloadBytes = inf.data.length;
      body = applyDelta(base.body, inf.data);
      resolvedType = base.type;
    } else if (type === 7) {
      const baseId = pack.subarray(p, p + 20).toString('hex');
      p += 20;
      const base = objects.get(baseId);
      if (!base) throw new Error(`ref delta base missing ${baseId}`);
      const inf = inflateAt(payload, p);
      p += inf.used;
      payloadBytes = inf.data.length;
      body = applyDelta(base.body, inf.data);
      resolvedType = base.type;
    } else {
      const t = NUM_TYPE[type];
      if (!t) throw new Error(`bad object type ${type}`);
      const inf = inflateAt(payload, p);
      p += inf.used;
      payloadBytes = inf.data.length;
      body = inf.data;
      resolvedType = t;
    }

    if (payloadBytes !== size) {
      throw new Error(`object size mismatch at ${at}: header ${size}, inflated ${payloadBytes}`);
    }
    const id = objectId(resolvedType, body);
    objects.set(id, { type: resolvedType, body });
    order.push(id);
    byOffset.set(at, id);
  }
  return { objects, order };
}

/** Deflated payloads, by object id: a pack built twice for the same objects skips zlib. */
const DEFLATED = new Map<string, { type: ObjType; raw: Buffer }>();
const DEFLATED_MAX = 8_000;

function deflatedOf(id: string, obj: PackedObject): Buffer {
  const hit = DEFLATED.get(id);
  if (hit && hit.type === obj.type) return hit.raw;
  const raw = deflateSync(obj.body, { level: 1 });
  if (DEFLATED.size >= DEFLATED_MAX) DEFLATED.clear();
  DEFLATED.set(id, { type: obj.type, raw });
  return raw;
}

/** Writes a packfile holding `ids` in order, every object whole (no deltas). */
export function writePack(ids: string[], read: (sha: string) => PackedObject | null): Buffer {
  const chunks: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  let written = 0;
  const bodyChunks: Buffer[] = [];
  for (const id of ids) {
    const obj = read(id);
    if (!obj) continue;
    const type = TYPE_NUM[obj.type];
    let size = obj.body.length;
    const bytes: number[] = [];
    let first = (type << 4) | (size & 15);
    size >>>= 4;
    while (size > 0) {
      bytes.push(first | 0x80);
      first = size & 0x7f;
      size >>>= 7;
    }
    bytes.push(first);
    bodyChunks.push(Buffer.from(bytes), deflatedOf(id, obj));
    written++;
  }
  header.writeUInt32BE(written, 8);
  chunks.push(header, ...bodyChunks);
  const body = Buffer.concat(chunks);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}
