// githttp.ts — the git smart-HTTP surface: protocol v2 and v0.
//
// The entry serves one repository at /<owner>/<repo>.git:
//   GET  /info/refs?service=git-upload-pack   (v2 when Git-Protocol: version=2)
//   GET  /info/refs?service=git-receive-pack  (v0 only)
//   POST /git-upload-pack                     (v2 ls-refs / fetch, or v0 fetch)
//   POST /git-receive-pack                    (v0 push, report-status in sideband)
//
// The wire details that matter (all verified against the kit's git-client.ts):
//   * v2 advertisement: first pkt-line `version 2`, caps fetch (with shallow),
//     ls-refs (with unborn), object-format=sha1.
//   * v0 advertisement: `# service=...` preamble + flush, first ref line carries
//     the capabilities after a NUL, peeled tags as `<oid> <ref>^{}`.
//   * v2 ls-refs: HEAD with symref-target, peeled tags when peel is asked,
//     server-side ref-prefix filtering (HEAD is omitted when a prefix is given).
//   * v2 fetch: sectioned response — acknowledgments, shallow-info, packfile —
//     each delimited; the pack rides band-1 sideband packets, never deltas.
//   * receive-pack: the report-status stream is pkt-lined inside band-1
//     sideband packets; a refused update is `ng <ref> non-fast-forward` and
//     the ref does not move, but the unpack still succeeds and the other refs
//     in the same push do apply.

import {
  buildTree,
  decodePktLines,
  encodePktLine,
  encodePktLines,
  isDescendant,
  isObjectId,
  parseCommit,
  parseTag,
  readPack,
  splitPktSection,
  ZERO_OID,
  type GitObject,
} from './gitcore.ts';
import type { Forge, Repo } from './store.ts';

const AGENT = 'forge/1.0.0';
const V2_CAPS: Array<[string, string]> = [
  ['agent', AGENT],
  ['ls-refs', 'unborn'],
  ['fetch', 'shallow wait-for-done'],
  ['object-format', 'sha1'],
];
const V0_UPLOAD_CAPS = `side-band-64k multi_ack thin-pack ofs-delta shallow symref=HEAD:refs/heads/main agent=${AGENT}`;
const V0_RECEIVE_CAPS = `report-status side-band-64k delete-refs ofs-delta symref=HEAD:refs/heads/main agent=${AGENT}`;

export interface GitResponse {
  status: number;
  contentType: string;
  body: Buffer;
}

function gitError(status: number, message: string): GitResponse {
  return {
    status,
    contentType: 'application/json',
    body: Buffer.from(JSON.stringify({ message }), 'utf8'),
  };
}

function repoOr404(forge: Forge, owner: string, name: string): Repo | GitResponse {
  const repo = forge.getRepo(owner, name);
  if (!repo) return gitError(404, `repository ${owner}/${name} not found`);
  return repo;
}

/** The refs of a repo, sorted by name, as (oid, name, peeled?) triples. */
function listRefs(repo: Repo): Array<{ oid: string; name: string; peeled?: string }> {
  const out: Array<{ oid: string; name: string; peeled?: string }> = [];
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name)!;
    const entry: { oid: string; name: string; peeled?: string } = { oid, name };
    const object = repo.objects.get(oid);
    if (object && object.type === 'tag') {
      entry.peeled = parseTag(object.data).object;
    }
    out.push(entry);
  }
  return out;
}

function headTip(repo: Repo): string | null {
  return repo.refs.get('refs/heads/main') ?? null;
}

// ---------------------------------------------------------------------------------------------
// advertisements
// ---------------------------------------------------------------------------------------------

export function handleInfoRefs(
  forge: Forge,
  owner: string,
  name: string,
  service: string,
  gitProtocol: string | null,
): GitResponse {
  const repo = repoOr404(forge, owner, name);
  if ('status' in repo) return repo;
  if (service === 'git-upload-pack' && gitProtocol === 'version=2') {
    const lines: string[] = ['version 2\n'];
    for (const [key, value] of V2_CAPS) lines.push(`${key}=${value}\n`);
    return {
      status: 200,
      contentType: 'application/x-git-upload-pack-advertisement',
      body: encodePktLines([...lines, 'flush']),
    };
  }
  const isReceive = service === 'git-receive-pack';
  const caps = isReceive ? V0_RECEIVE_CAPS : V0_UPLOAD_CAPS;
  const serviceName = isReceive ? 'git-receive-pack' : 'git-upload-pack';
  const refs = listRefs(repo);
  const lines: Array<string | 'flush'> = [`# service=${serviceName}\n`, 'flush'];
  const tip = headTip(repo);
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  } else {
    const headLine = tip ? `${tip} HEAD\0${caps}\n` : `${ZERO_OID} HEAD\0${caps}\n`;
    lines.push(headLine);
    for (const ref of refs) {
      lines.push(`${ref.oid} ${ref.name}\n`);
      if (ref.peeled) lines.push(`${ref.peeled} ${ref.name}^{}\n`);
    }
  }
  lines.push('flush');
  return {
    status: 200,
    contentType: `application/x-${serviceName}-advertisement`,
    body: encodePktLines(lines),
  };
}

// ---------------------------------------------------------------------------------------------
// v2 ls-refs
// ---------------------------------------------------------------------------------------------

interface LsRefsRequest {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function parseLsRefs(packets: ReturnType<typeof decodePktLines>): LsRefsRequest {
  const req: LsRefsRequest = { peel: false, symrefs: false, unborn: false, prefixes: [] };
  let seenDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      seenDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8');
    if (!seenDelim) continue; // command=, agent=, object-format= lines
    if (line === 'peel\n') req.peel = true;
    else if (line === 'symrefs\n') req.symrefs = true;
    else if (line === 'unborn\n') req.unborn = true;
    else if (line.startsWith('ref-prefix ')) req.prefixes.push(line.slice('ref-prefix '.length).replace(/\n$/, ''));
  }
  return req;
}

function handleLsRefs(repo: Repo, req: LsRefsRequest): GitResponse {
  const refs = listRefs(repo);
  const tip = headTip(repo);
  const lines: string[] = [];
  const matchPrefix = (name: string): boolean =>
    req.prefixes.length === 0 || req.prefixes.some((prefix) => name.startsWith(prefix));
  // HEAD is a ref like any other: it is listed when it matches a prefix
  // (a clone asks for ref-prefix HEAD, refs/heads/ and refs/tags/).
  if (matchPrefix('HEAD')) {
    if (tip) {
      lines.push(req.symrefs ? `${tip} HEAD symref-target:refs/heads/main\n` : `${tip} HEAD\n`);
    } else if (req.unborn) {
      lines.push(req.symrefs ? `unborn HEAD symref-target:refs/heads/main\n` : `unborn HEAD\n`);
    }
  }
  for (const ref of refs) {
    if (!matchPrefix(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (req.peel && ref.peeled) line += ` peeled:${ref.peeled}`;
    lines.push(`${line}\n`);
  }
  return {
    status: 200,
    contentType: 'application/x-git-upload-pack-result',
    body: encodePktLines([...lines, 'flush']),
  };
}

// ---------------------------------------------------------------------------------------------
// fetch (v2 and v0)
// ---------------------------------------------------------------------------------------------

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth?: number;
}

function parseFetchV2(packets: ReturnType<typeof decodePktLines>): FetchRequest {
  const req: FetchRequest = { wants: [], haves: [], shallow: [] };
  let seenDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      seenDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8');
    if (!seenDelim) continue;
    const text = line.replace(/\n$/, '');
    if (text.startsWith('want ')) req.wants.push(text.slice(5));
    else if (text.startsWith('have ')) req.haves.push(text.slice(5));
    else if (text.startsWith('shallow ')) req.shallow.push(text.slice(8));
    else if (text.startsWith('deepen ')) req.depth = Number(text.slice(7));
  }
  return req;
}

function parseFetchV0(packets: ReturnType<typeof decodePktLines>): FetchRequest {
  const req: FetchRequest = { wants: [], haves: [], shallow: [] };
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const text = packet.payload.toString('utf8').replace(/\n$/, '');
    // The first want line may carry capabilities after a space; the oid is the first token.
    if (text.startsWith('want ')) req.wants.push(text.slice(5).split(' ')[0]!);
    else if (text.startsWith('have ')) req.haves.push(text.slice(5));
    else if (text.startsWith('shallow ')) req.shallow.push(text.slice(8));
    else if (text.startsWith('deepen ')) req.depth = Number(text.slice(7));
  }
  return req;
}

/** Split a pack into sideband pkt-lines (band 1), each carrying at most 65515 pack bytes. */
function sidebandPack(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const CHUNK = 65515;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const piece = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    out.push(encodePktLine(Buffer.concat([Buffer.from([1]), piece])));
  }
  if (pack.length === 0) out.push(encodePktLine(Buffer.from([1])));
  return out;
}

function handleFetch(forge: Forge, repo: Repo, req: FetchRequest, v2: boolean): GitResponse {
  const wants = [...new Set(req.wants)].filter((oid) => isObjectId(oid));
  const hasHaves = req.haves.length > 0;
  if (wants.length === 0) {
    // No wants: an empty pack, no objects (a clone of an empty repo never fetches).
    const empty = forge.fetchPack(repo, [], [], req.shallow, req.depth);
    return v2 ? fetchV2Response(repo, [], hasHaves, empty) : fetchV0Response(repo, [], empty);
  }
  const { pack, shallow, unshallow } = forge.fetchPack(repo, wants, req.haves, req.shallow, req.depth);
  const acked: string[] = [];
  for (const have of req.haves) {
    if (repo.objects.has(have)) acked.push(have);
  }
  return v2
    ? fetchV2Response(repo, acked, hasHaves, { pack, shallow, unshallow })
    : fetchV0Response(repo, acked, { pack, shallow, unshallow });
}

function fetchV2Response(
  _repo: Repo,
  acked: string[],
  hasHaves: boolean,
  result: { pack: Buffer; shallow: string[]; unshallow: string[] },
): GitResponse {
  const parts: Buffer[] = [];
  // The acknowledgments section is conditional on the client having sent
  // haves: a real git client that sent haves expects it ("expected
  // 'acknowledgments', received 'packfile'" without it), while a client
  // that sent none expects the packfile section straight away ("expected
  // 'packfile', received 'acknowledgments'" with it). A fresh clone sends
  // no haves; an incremental fetch does.
  if (hasHaves) {
    // acknowledgments section: header, then the ACK/NAK lines, then the delim.
    parts.push(encodePktLine('acknowledgments\n'));
    if (acked.length > 0) {
      for (const oid of acked) parts.push(encodePktLine(`ACK ${oid}\n`));
      parts.push(encodePktLine('ready\n'));
    } else {
      parts.push(encodePktLine('NAK\n'));
    }
    parts.push(Buffer.from('0001', 'ascii'));
  }
  if (result.shallow.length > 0 || result.unshallow.length > 0) {
    // shallow-info section: header, then the shallow/unshallow lines, then the delim.
    parts.push(encodePktLine('shallow-info\n'));
    for (const oid of result.shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
    for (const oid of result.unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
    parts.push(Buffer.from('0001', 'ascii'));
  }
  // packfile section: header, then the sideband packets, then the flush.
  parts.push(encodePktLine('packfile\n'));
  for (const packet of sidebandPack(result.pack)) parts.push(packet);
  parts.push(Buffer.from('0000', 'ascii'));
  return {
    status: 200,
    contentType: 'application/x-git-upload-pack-result',
    body: Buffer.concat(parts),
  };
}

function fetchV0Response(
  _repo: Repo,
  acked: string[],
  result: { pack: Buffer; shallow: string[]; unshallow: string[] },
): GitResponse {
  const parts: Buffer[] = [];
  if (acked.length > 0) {
    for (const oid of acked) parts.push(encodePktLine(`ACK ${oid}\n`));
  } else {
    parts.push(encodePktLine('NAK\n'));
  }
  for (const oid of result.shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
  for (const oid of result.unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
  for (const packet of sidebandPack(result.pack)) parts.push(packet);
  parts.push(Buffer.from('0000', 'ascii'));
  return {
    status: 200,
    contentType: 'application/x-git-upload-pack-result',
    body: Buffer.concat(parts),
  };
}

// ---------------------------------------------------------------------------------------------
// upload-pack POST dispatcher (ls-refs / fetch, v2 or v0)
// ---------------------------------------------------------------------------------------------

export function handleUploadPack(
  forge: Forge,
  owner: string,
  name: string,
  body: Buffer,
  gitProtocol: string | null,
): GitResponse {
  const repo = repoOr404(forge, owner, name);
  if ('status' in repo) return repo;
  let packets;
  try {
    packets = decodePktLines(body);
  } catch {
    return gitError(400, 'malformed pkt-line stream');
  }
  const first = packets.find((p) => p.kind === 'data');
  const command = first && first.kind === 'data' ? first.payload.toString('utf8').replace(/\n$/, '') : '';
  const v2 = gitProtocol === 'version=2';
  if (command === 'command=ls-refs') {
    if (!v2) return gitError(400, 'ls-refs requires protocol v2');
    return handleLsRefs(repo, parseLsRefs(packets));
  }
  if (command === 'command=fetch') {
    if (!v2) return gitError(400, 'fetch requires protocol v2');
    return handleFetch(forge, repo, parseFetchV2(packets), true);
  }
  if (v2) return gitError(400, `unknown v2 command ${JSON.stringify(command)}`);
  // v0 fetch: the first line is `want <oid> ...`.
  return handleFetch(forge, repo, parseFetchV0(packets), false);
}

// ---------------------------------------------------------------------------------------------
// receive-pack POST (push)
// ---------------------------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export function handleReceivePack(forge: Forge, owner: string, name: string, body: Buffer): GitResponse {
  const repo = repoOr404(forge, owner, name);
  if ('status' in repo) return repo;
  let commands: PushCommand[];
  let packBytes: Buffer;
  try {
    const { packets, rest } = splitPktSection(body);
    commands = [];
    for (const packet of packets) {
      if (packet.kind !== 'data') continue;
      let line = packet.payload.toString('utf8');
      const nul = line.indexOf('\0');
      if (nul >= 0) line = line.slice(0, nul);
      const text = line.replace(/\n$/, '');
      if (!text) continue;
      const [oldOid, newOid, ref] = text.split(' ');
      if (!oldOid || !newOid || !ref) throw new Error('bad push command line');
      commands.push({ oldOid, newOid, ref });
    }
    packBytes = Buffer.from(rest);
  } catch {
    return gitError(400, 'malformed push stream');
  }
  if (commands.length === 0) return gitError(400, 'push needs at least one command');

  // Unpack first: the pack must parse and verify before any ref moves.
  let unpackError: string | null = null;
  const updatesRef = commands.some((c) => c.newOid !== ZERO_OID);
  if (updatesRef && packBytes.length > 0) {
    try {
      const objects = readPack(packBytes, (oid) => repo.objects.get(oid));
      for (const [oid, object] of objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
      forge.bump(repo);
    } catch (err) {
      unpackError = err instanceof Error ? err.message : String(err);
    }
  }

  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  if (unpackError === null) {
    for (const command of commands) {
      const { oldOid, newOid, ref } = command;
      const current = repo.refs.get(ref);
      const isTag = ref.startsWith('refs/tags/');
      if (newOid === ZERO_OID) {
        // Delete.
        if (!current) {
          results.push({ ref, ok: false, reason: 'non-fast-forward' });
        } else if (oldOid !== ZERO_OID && oldOid !== current) {
          results.push({ ref, ok: false, reason: 'non-fast-forward' });
        } else {
          repo.refs.delete(ref);
          results.push({ ref, ok: true, reason: '' });
        }
        continue;
      }
      // Create or update: the new object must be present.
      const newObject = repo.objects.get(newOid);
      if (!newObject) {
        results.push({ ref, ok: false, reason: 'object not found' });
        continue;
      }
      if (oldOid === ZERO_OID) {
        if (current) {
          results.push({ ref, ok: false, reason: 'already exists' });
        } else {
          repo.refs.set(ref, newOid);
          results.push({ ref, ok: true, reason: '' });
        }
        continue;
      }
      if (!current) {
        results.push({ ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
      if (oldOid !== current) {
        results.push({ ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
      if (newOid === current) {
        results.push({ ref, ok: true, reason: '' });
        continue;
      }
      if (isTag) {
        results.push({ ref, ok: false, reason: 'already exists' });
        continue;
      }
      const lookup = (oid: string) => repo.objects.get(oid);
      if (isDescendant(lookup, current, newOid)) {
        repo.refs.set(ref, newOid);
        results.push({ ref, ok: true, reason: '' });
      } else {
        results.push({ ref, ok: false, reason: 'non-fast-forward' });
      }
    }
    if (results.some((r) => r.ok)) forge.bump(repo);
  }

  // Report-status, pkt-lined inside band-1 sideband packets.
  const reportLines: Array<string | 'flush'> = [];
  reportLines.push(unpackError === null ? 'unpack ok\n' : `unpack ${unpackError}\n`);
  if (unpackError === null) {
    for (const result of results) {
      reportLines.push(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`);
    }
  }
  reportLines.push('flush');
  const reportBytes = encodePktLines(reportLines);
  const parts: Buffer[] = [];
  const CHUNK = 65515;
  for (let offset = 0; offset < reportBytes.length; offset += CHUNK) {
    const piece = reportBytes.subarray(offset, Math.min(reportBytes.length, offset + CHUNK));
    parts.push(encodePktLine(Buffer.concat([Buffer.from([1]), piece])));
  }
  parts.push(Buffer.from('0000', 'ascii'));
  return {
    status: 200,
    contentType: 'application/x-git-receive-pack-result',
    body: Buffer.concat(parts),
  };
}
