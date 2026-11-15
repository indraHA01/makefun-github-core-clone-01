// gitcore.ts — the git object model, pack format and wire framing, from scratch.
//
// No git binary, no library: SHA-1 object ids, tree/commit/tag bytes, the
// PACK v2 format (plain objects only — this forge never sends deltas, which
// the suite explicitly allows), pkt-line framing, and the reachability walk
// that decides exactly which objects a fetch sends. Every byte format mirrors
// the kit's git-client.ts so the sealed client's parser accepts it.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0000000000000000000000000000000000000000';
const HEX40 = /^[0-9a-f]{40}$/;
export function isObjectId(value: string): boolean {
  return HEX40.test(value);
}

export type GitObjectType = 'blob' | 'tree' | 'commit' | 'tag';
export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}
export type ObjectLookup = (oid: string) => GitObject | undefined;

export function hashObject(type: GitObjectType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${type} ${data.length}\0`, 'utf8'));
  hash.update(data);
  return hash.digest('hex');
}

// ---------------------------------------------------------------------------------------------
// trees, commits, tags
// ---------------------------------------------------------------------------------------------

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space + 1);
    if (space < 0 || nul < 0 || nul + 21 > data.length) throw new Error('malformed tree object');
    entries.push({
      mode: data.subarray(offset, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

/** git's tree-entry sort: byte order of the name, a directory compared as if it ended in '/'. */
function compareTreeNames(a: TreeEntry, b: TreeEntry): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  if (!isObjectId(tree)) throw new Error('commit has no valid tree header');
  return { tree, parents, author, committer, message };
}

export interface BuildCommitFields {
  tree: string;
  parents?: readonly string[];
  message: string;
  author: string;
  committer: string;
  timestamp: number;
}

export function buildCommit(fields: BuildCommitFields): Buffer {
  const who = `${fields.author} ${fields.timestamp} +0000`;
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents ?? []) lines.push(`parent ${parent}`);
  lines.push(`author ${who}`, `committer ${who}`, '');
  return Buffer.from(`${lines.join('\n')}\n${fields.message}`, 'utf8');
}

export interface TagView {
  object: string;
  type: GitObjectType;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): TagView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headers = new Map<string, string>();
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space < 0) continue;
    headers.set(line.slice(0, space), line.slice(space + 1));
  }
  return {
    object: headers.get('object') ?? '',
    type: (headers.get('type') ?? 'commit') as GitObjectType,
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : data.subarray(blank + 2).toString('utf8'),
  };
}

export function buildTag(fields: { object: string; type: GitObjectType; tag: string; tagger: string; timestamp: number; message: string }): Buffer {
  const lines = [
    `object ${fields.object}`,
    `type ${fields.type}`,
    `tag ${fields.tag}`,
    `tagger ${fields.tagger} ${fields.timestamp} +0000`,
    '',
  ];
  return Buffer.from(`${lines.join('\n')}\n${fields.message}`, 'utf8');
}

/** Flatten a tree to path -> {mode, oid}, following subtrees. */
export function flattenTree(lookup: ObjectLookup, treeOid: string): Map<string, { mode: string; oid: string }> {
  const out = new Map<string, { mode: string; oid: string }>();
  const walk = (oid: string, prefix: string): void => {
    const object = lookup(oid);
    if (!object || object.type !== 'tree') return;
    for (const entry of parseTree(object.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else out.set(path, { mode: entry.mode, oid: entry.oid });
    }
  };
  walk(treeOid, '');
  return out;
}

// ---------------------------------------------------------------------------------------------
// pkt-lines
// ---------------------------------------------------------------------------------------------

export function encodePktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = body.length + 4;
  if (length > 65520) throw new Error('pkt-line too long');
  const head = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}

export function pktLineFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}
export function pktLineDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}
export function pktLineResponseEnd(): Buffer {
  return Buffer.from('0002', 'ascii');
}

export type PktItem = string | Buffer | 'flush' | 'delim' | 'response-end';
export function encodePktLines(items: readonly PktItem[]): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(pktLineFlush());
    else if (item === 'delim') parts.push(pktLineDelim());
    else if (item === 'response-end') parts.push(pktLineResponseEnd());
    else parts.push(encodePktLine(item));
  }
  return Buffer.concat(parts);
}

export type GitPacket =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

/** Decode a whole pkt-line stream. Throws on a malformed length (a client that sends garbage). */
export function decodePktLines(bytes: Buffer): GitPacket[] {
  const packets: GitPacket[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    if (offset + 4 > bytes.length) throw new Error('truncated pkt-line length');
    const text = bytes.subarray(offset, offset + 4).toString('ascii');
    const length = parseInt(text, 16);
    if (Number.isNaN(length)) throw new Error(`bad pkt-line length ${JSON.stringify(text)}`);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
    } else if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
    } else if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
    } else {
      if (offset + length > bytes.length) throw new Error('truncated pkt-line payload');
      packets.push({ kind: 'data', payload: Buffer.from(bytes.subarray(offset + 4, offset + length)) });
      offset += length;
    }
  }
  return packets;
}

/** Split a request body into its pkt-line text section and the raw pack that follows it. */
export function splitPktSection(body: Buffer): { packets: GitPacket[]; rest: Buffer } {
  let offset = 0;
  const packets: GitPacket[] = [];
  while (offset < body.length) {
    if (offset + 4 > body.length) throw new Error('truncated pkt-line length');
    const length = parseInt(body.subarray(offset, offset + 4).toString('ascii'), 16);
    if (Number.isNaN(length)) throw new Error('bad pkt-line length');
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      break;
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (offset + length > body.length) throw new Error('truncated pkt-line payload');
    packets.push({ kind: 'data', payload: Buffer.from(body.subarray(offset + 4, offset + length)) });
    offset += length;
  }
  return { packets, rest: body.subarray(offset) };
}

// ---------------------------------------------------------------------------------------------
// packs (plain objects only; the suite allows zero deltas and this forge never sends any)
// ---------------------------------------------------------------------------------------------

const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function writePackObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a PACK v2 file from plain objects, sorted by oid for determinism. */
export function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects].map((o) => ({ ...o, oid: hashObject(o.type, o.data) }));
  list.sort((a, b) => (a.oid < b.oid ? -1 : a.oid > b.oid ? 1 : 0));
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const object of list) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

function readVarintSize(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  let byte = buffer[start]!;
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    byte = buffer[offset++]!;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { size, next: offset, first };
}

function readOfsDeltaBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  let byte = buffer[start]!;
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    byte = buffer[offset++]!;
    value = ((value + 1) * 128) + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const view = buffer.subarray(offset);
  const result = inflateSync(view, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error('zlib stream consumed no bytes');
  return { data: result.buffer, next: offset + written };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset++]!;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++]!;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) copyOffset += delta[offset++]! * 2 ** shift;
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) copySize += delta[offset++]! * 2 ** shift;
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (written !== targetSize) throw new Error('delta size mismatch');
  return out;
}

export interface PackEntry {
  oid: string;
  type: GitObjectType;
  data: Buffer;
}

/**
 * Read a PACK v2/v3 file and resolve every object (plain, OFS_DELTA and
 * REF_DELTA; a thin pack's REF_DELTA base is resolved against `resolveBase`).
 * Every object's SHA-1 is recomputed and its declared size checked.
 */
export function readPack(pack: Buffer, resolveBase?: ObjectLookup): Map<string, GitObject> {
  if (pack.length < 32) throw new Error('pack too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  const computed = createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex');
  if (trailer !== computed) throw new Error('pack trailer checksum mismatch');

  interface Raw {
    offset: number;
    typeCode: number;
    size: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
  }
  const raw: Raw[] = [];
  const byOffset = new Map<number, Raw>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readVarintSize(pack, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: Raw = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsDeltaBase(pack, offset);
      offset = base.next;
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`pack entry ${index} has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(pack.subarray(0, trailerStart), offset);
    if (inflated.data.length !== header.size) throw new Error('pack entry size mismatch');
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }

  const resolved = new Map<string, GitObject>();
  const resolve = (entry: Raw): GitObject => {
    if (entry.typeCode === 6 || entry.typeCode === 7) {
      let base: GitObject | undefined;
      if (entry.typeCode === 6) {
        const baseEntry = byOffset.get(entry.baseOffset!);
        if (!baseEntry) throw new Error('ofs-delta base not in pack');
        base = resolve(baseEntry);
      } else {
        const baseOid = entry.baseOid!;
        const inPack = raw.find((candidate) => {
          if (candidate.typeCode === 6 || candidate.typeCode === 7) return false;
          return hashObject(CODE_TYPE[candidate.typeCode]!, candidate.data) === baseOid;
        });
        if (inPack) base = { type: CODE_TYPE[inPack.typeCode]!, data: inPack.data };
        else if (resolveBase) base = resolveBase(baseOid);
        if (!base) throw new Error(`ref-delta base ${baseOid} not available`);
      }
      const data = applyDelta(base.data, entry.data);
      return { type: base.type, data };
    }
    const type = CODE_TYPE[entry.typeCode]!;
    return { type, data: entry.data };
  };
  for (const entry of raw) {
    const object = resolve(entry);
    resolved.set(hashObject(object.type, object.data), object);
  }
  return resolved;
}

// ---------------------------------------------------------------------------------------------
// reachability — the exact send set of a fetch
// ---------------------------------------------------------------------------------------------

export interface SendSet {
  /** Objects to send (oid -> object), already minus what the client holds. */
  objects: Map<string, GitObject>;
  /** The new shallow boundary commits (depth limit reached). */
  shallow: string[];
  /** Client shallow commits whose parents are now available. */
  unshallow: string[];
}

/**
 * Compute what a fetch sends. `wants` are commit/tag oids; `haves` are oids the
 * client already holds; `clientShallow` is the client's shallow boundary (its
 * walk must not cross it); `depth` caps commit generations from the wants.
 */
export function computeSendSet(
  lookup: ObjectLookup,
  wants: readonly string[],
  haves: readonly string[],
  clientShallow: readonly string[],
  depth?: number,
): SendSet {
  const shallowSet = new Set(clientShallow);
  const wanted = new Map<string, GitObject>(); // oid -> object, the depth-limited closure
  const generation = new Map<string, number>(); // commit oid -> generation from a want
  const boundary = new Set<string>(); // commits at exactly the depth limit

  const addObject = (oid: string, object: GitObject): void => {
    if (!wanted.has(oid)) wanted.set(oid, object);
  };
  const addTreeClosure = (treeOid: string): void => {
    const stack = [treeOid];
    const seen = new Set<string>();
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = lookup(oid);
      if (!object) continue;
      addObject(oid, object);
      if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) stack.push(entry.oid);
      }
    }
  };

  // Walk commits from the wants, breadth-first by generation.
  const queue: Array<{ oid: string; gen: number }> = [];
  for (const want of wants) {
    const object = lookup(want);
    if (!object) continue;
    if (object.type === 'tag') {
      addObject(want, object);
      const target = parseTag(object.data).object;
      const targetObject = lookup(target);
      if (targetObject && targetObject.type === 'commit' && !generation.has(target)) {
        generation.set(target, 1);
        queue.push({ oid: target, gen: 1 });
      } else if (targetObject) {
        addObject(target, targetObject);
      }
    } else if (object.type === 'commit') {
      if (!generation.has(want)) {
        generation.set(want, 1);
        queue.push({ oid: want, gen: 1 });
      }
    } else {
      addObject(want, object);
    }
  }
  while (queue.length > 0) {
    const { oid, gen } = queue.shift()!;
    if (depth !== undefined && gen > depth) continue;
    const object = lookup(oid);
    if (!object || object.type !== 'commit') continue;
    addObject(oid, object);
    const commit = parseCommit(object.data);
    addTreeClosure(commit.tree);
    if (depth !== undefined && gen === depth) {
      boundary.add(oid);
      continue;
    }
    for (const parent of commit.parents) {
      if (!generation.has(parent)) {
        generation.set(parent, gen + 1);
        queue.push({ oid: parent, gen: gen + 1 });
      }
    }
  }

  // What the client already holds: reachable from the haves without crossing
  // a shallow boundary (a shallow commit's tree/blobs are held, its parents are not).
  const held = new Set<string>();
  const addHeldTreeClosure = (treeOid: string): void => {
    const stack = [treeOid];
    const seen = new Set<string>();
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = lookup(oid);
      if (!object) continue;
      held.add(oid);
      if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) stack.push(entry.oid);
      }
    }
  };
  const heldQueue: string[] = [...haves];
  const heldSeen = new Set<string>();
  while (heldQueue.length > 0) {
    const oid = heldQueue.pop()!;
    if (heldSeen.has(oid)) continue;
    heldSeen.add(oid);
    const object = lookup(oid);
    if (!object) continue;
    held.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      addHeldTreeClosure(commit.tree);
      if (shallowSet.has(oid)) continue; // do not cross the shallow boundary
      for (const parent of commit.parents) heldQueue.push(parent);
    } else if (object.type === 'tree') {
      addHeldTreeClosure(oid);
    } else if (object.type === 'tag') {
      const target = parseTag(object.data).object;
      heldQueue.push(target);
    }
  }

  const objects = new Map<string, GitObject>();
  for (const [oid, object] of wanted) {
    if (!held.has(oid)) objects.set(oid, object);
  }

  // Shallow boundaries of this fetch: commits at the depth limit whose
  // parents are still missing afterwards (not in the send set, not held).
  const available = new Set<string>([...wanted.keys(), ...held]);
  const shallow: string[] = [];
  for (const oid of boundary) {
    const object = lookup(oid);
    if (!object || object.type !== 'commit') continue;
    const parents = parseCommit(object.data).parents;
    if (parents.length > 0 && parents.every((p) => available.has(p))) continue;
    shallow.push(oid);
  }

  // Unshallow: a client shallow commit whose parents are all available now.
  const unshallow: string[] = [];
  for (const oid of clientShallow) {
    const object = lookup(oid);
    if (!object || object.type !== 'commit') continue;
    const parents = parseCommit(object.data).parents;
    if (parents.length === 0) continue;
    if (parents.every((p) => available.has(p))) unshallow.push(oid);
  }

  return { objects, shallow, unshallow };
}

/** True when `tip` is `ancestor` or a descendant of it (fast-forward check). */
export function isDescendant(lookup: ObjectLookup, ancestor: string, tip: string): boolean {
  if (ancestor === tip) return true;
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = lookup(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) stack.push(parent);
  }
  return false;
}

/** The merge-base of two commits (the common ancestor nearest both), or null. */
export function mergeBase(lookup: ObjectLookup, a: string, b: string): string | null {
  const distA = new Map<string, number>();
  const queueA: Array<[string, number]> = [[a, 0]];
  while (queueA.length > 0) {
    const [oid, dist] = queueA.shift()!;
    if (distA.has(oid)) continue;
    distA.set(oid, dist);
    const object = lookup(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queueA.push([parent, dist + 1]);
  }
  let best: string | null = null;
  let bestDist = Infinity;
  const queueB: Array<[string, number]> = [[b, 0]];
  const seenB = new Set<string>();
  while (queueB.length > 0) {
    const [oid, dist] = queueB.shift()!;
    if (seenB.has(oid)) continue;
    seenB.add(oid);
    const distInA = distA.get(oid);
    if (distInA !== undefined) {
      const total = distInA + dist;
      if (total < bestDist) {
        bestDist = total;
        best = oid;
      }
    }
    const object = lookup(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queueB.push([parent, dist + 1]);
  }
  return best;
}
