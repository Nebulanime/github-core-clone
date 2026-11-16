// git smart HTTP: info/refs advertisements (v2 upload-pack, v0 upload-pack and
// receive-pack), v2 ls-refs and fetch, v0 fetch, and receive-pack pushes with
// report-status over sideband. No git binary anywhere: packs are built and read
// here, objects live in the forge's in-memory store.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  DELIM_PKT,
  FLUSH_PKT,
  Forge,
  ZERO_OID,
  decodePktLines,
  encodePktLine,
  hashObject,
  parseCommit,
  parseTag,
  parseTree,
  readPack,
  splitAtFlush,
  writePack,
  type GitObject,
  type ObjType,
  type Repo,
} from './store.ts';
import { sendError, sendRaw } from './http.ts';

const AGENT = 'makefun-forge/1.0';
const UPLOAD_CAPS_V0 = 'side-band-64k shallow thin-pack ofs-delta symref=HEAD:refs/heads/main agent=makefun-forge/1.0';
const RECEIVE_CAPS_V0 = 'report-status side-band-64k delete-refs ofs-delta agent=makefun-forge/1.0';
const UPLOAD_AD_CT = 'application/x-git-upload-pack-advertisement';
const RECEIVE_AD_CT = 'application/x-git-receive-pack-advertisement';
const UPLOAD_RESULT_CT = 'application/x-git-upload-pack-result';
const RECEIVE_RESULT_CT = 'application/x-git-receive-pack-result';

/** The HEAD tip: the default branch, or the first branch when main is unborn. */
function headTip(forge: Forge, repo: Repo): string | undefined {
  const main = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (main !== undefined) return main;
  const branches = forge.branches(repo);
  if (branches.length === 0) return undefined;
  return (branches[0] as { oid: string }).oid;
}

interface RefLine {
  oid: string;
  name: string;
  peeled?: string;
}

/** The ref lines for a v0 advertisement (peeled annotated tags included). */
function v0RefLines(forge: Forge, repo: Repo): RefLine[] {
  const lines: RefLine[] = [];
  for (const ref of forge.sortedRefs(repo)) {
    lines.push({ oid: ref.oid, name: ref.name });
    if (ref.name.startsWith('refs/tags/')) {
      const object = repo.objects.get(ref.oid);
      if (object !== undefined && object.type === 'tag') {
        const target = parseTag(object.data);
        if (target.type === 'commit') lines.push({ oid: target.object, name: `${ref.name}^{}` });
      }
    }
  }
  return lines;
}

function v0Advertisement(service: 'git-upload-pack' | 'git-receive-pack', forge: Forge, repo: Repo): Buffer {
  const caps = service === 'git-upload-pack' ? UPLOAD_CAPS_V0 : RECEIVE_CAPS_V0;
  const parts: Buffer[] = [encodePktLine(`# service=${service}\n`), FLUSH_PKT];
  const tip = headTip(forge, repo);
  const refs = v0RefLines(forge, repo);
  if (refs.length === 0) {
    parts.push(encodePktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const first = refs[0] as RefLine;
    // The HEAD line carries the capabilities; it precedes the ref lines.
    const headLine =
      tip !== undefined
        ? `${tip} HEAD\0${caps}\n`
        : `${ZERO_OID} HEAD\0${caps}\n`;
    parts.push(encodePktLine(headLine));
    for (const ref of refs) parts.push(encodePktLine(`${ref.oid} ${ref.name}\n`));
  }
  parts.push(FLUSH_PKT);
  return Buffer.concat(parts);
}

function v2Advertisement(): Buffer {
  return Buffer.concat([
    encodePktLine('# service=git-upload-pack\n'),
    FLUSH_PKT,
    encodePktLine('version 2\n'),
    encodePktLine(`agent=${AGENT}\n`),
    encodePktLine('ls-refs=unborn\n'),
    encodePktLine('fetch=shallow filter\n'),
    encodePktLine('object-format=sha1\n'),
    FLUSH_PKT,
  ]);
}

/** GET /{owner}/{repo}.git/info/refs?service=... */
export function handleInfoRefs(forge: Forge, req: IncomingMessage, res: ServerResponse, owner: string, repoName: string): void {
  const repo = forge.getRepo(owner, repoName);
  if (repo === undefined) {
    sendError(res, 404, 'Not Found');
    return;
  }
  let service = '';
  try {
    service = new URL(req.url ?? '/', 'http://entry').searchParams.get('service') ?? '';
  } catch {
    service = '';
  }
  if (service === 'git-receive-pack') {
    sendRaw(res, 200, v0Advertisement('git-receive-pack', forge, repo), RECEIVE_AD_CT);
    return;
  }
  if (service === 'git-upload-pack') {
    const wantsV2 = (req.headers['git-protocol'] ?? '').includes('version=2');
    if (wantsV2) {
      sendRaw(res, 200, v2Advertisement(), UPLOAD_AD_CT);
    } else {
      sendRaw(res, 200, v0Advertisement('git-upload-pack', forge, repo), UPLOAD_AD_CT);
    }
    return;
  }
  sendError(res, 400, 'unknown service');
}

// ---------------------------------------------------------------------------
// Fetch planning (shared by v2 and v0).
// ---------------------------------------------------------------------------

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallows: string[];
  deepen: number | null;
  filter: string | null;
}

interface FetchPlan {
  objects: GitObject[];
  shallow: string[];
  unshallow: string[];
  acks: string[];
  nak: boolean;
}

/** The tree+blob closure of one tree (no commits). */
function treeClosure(forge: Forge, repo: Repo, treeOid: string, out: Map<string, GitObject>): void {
  const stack: string[] = [treeOid];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    const object = repo.objects.get(oid);
    if (object === undefined || out.has(oid)) continue;
    out.set(oid, object);
    if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.oid);
    }
  }
}

function planFetch(forge: Forge, repo: Repo, args: FetchArgs): FetchPlan {
  // What the client already holds. In a shallow fetch (deepen, or shallow
  // boundaries) a have is a boundary commit: the client holds that commit and
  // its tree, not its ancestors. In a plain fetch a have carries its history.
  const shallowMode = args.deepen !== null || args.shallows.length > 0;
  const held = new Set<string>();
  for (const tip of [...args.haves, ...args.shallows]) {
    if (!shallowMode) {
      for (const oid of forge.reachable(repo, [tip])) held.add(oid);
      continue;
    }
    const object = repo.objects.get(tip);
    if (object === undefined) continue;
    held.add(tip);
    if (object.type === 'commit') {
      const closure = new Map<string, GitObject>();
      treeClosure(forge, repo, parseCommit(object.data).tree, closure);
      for (const oid of closure.keys()) held.add(oid);
    } else if (object.type === 'tag') {
      const target = parseTag(object.data).object;
      const targetObject = repo.objects.get(target);
      if (targetObject !== undefined && targetObject.type === 'commit') {
        held.add(target);
        const closure = new Map<string, GitObject>();
        treeClosure(forge, repo, parseCommit(targetObject.data).tree, closure);
        for (const oid of closure.keys()) held.add(oid);
      }
    }
  }

  // The commits included, newest first, with their generation (0 = the wants).
  const includedCommits: string[] = [];
  const generation = new Map<string, number>();
  if (args.deepen !== null) {
    const queue: Array<{ oid: string; gen: number }> = [];
    const seen = new Set<string>();
    for (const want of args.wants) {
      const target = wantTarget(forge, repo, want);
      if (target !== null && !seen.has(target)) {
        seen.add(target);
        queue.push({ oid: target, gen: 0 });
      }
    }
    while (queue.length > 0) {
      const { oid, gen } = queue.shift() as { oid: string; gen: number };
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      includedCommits.push(oid);
      generation.set(oid, gen);
      if (gen + 1 >= (args.deepen as number)) continue;
      for (const parent of parseCommit(object.data).parents) {
        if (!seen.has(parent)) {
          seen.add(parent);
          queue.push({ oid: parent, gen: gen + 1 });
        }
      }
    }
  } else {
    // Full reachability from every want, newest-first (a BFS from the wants;
    // tag wants resolve through the tag).
    const seen = new Set<string>();
    const queue = [...args.wants];
    while (queue.length > 0) {
      const oid = queue.shift() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (object === undefined) continue;
      if (object.type === 'tag') {
        const target = parseTag(object.data).object;
        if (!seen.has(target)) queue.push(target);
        continue;
      }
      if (object.type !== 'commit') continue;
      includedCommits.push(oid);
      for (const parent of parseCommit(object.data).parents) queue.push(parent);
    }
    for (const oid of includedCommits) generation.set(oid, 0);
  }

  // The objects to send: the included commits and their tree closures, minus held.
  const included = new Map<string, GitObject>();
  const tagObjects: GitObject[] = [];
  for (const want of args.wants) {
    const object = repo.objects.get(want);
    if (object !== undefined && object.type === 'tag') tagObjects.push(object);
  }
  for (const oid of includedCommits) {
    const object = repo.objects.get(oid);
    if (object === undefined) continue;
    included.set(oid, object);
    const tree = parseCommit(object.data).tree;
    treeClosure(forge, repo, tree, included);
  }
  for (const tag of tagObjects) included.set(hashObject(tag.type, tag.data), tag);

  const objects: GitObject[] = [];
  for (const [oid, object] of included) {
    if (!held.has(oid)) objects.push(object);
  }
  // Deterministic order: commits newest-first, then tags, trees, blobs.
  const typeRank = (type: ObjType): number => (type === 'commit' ? 0 : type === 'tag' ? 1 : type === 'tree' ? 2 : 3);
  const commitIndex = new Map(includedCommits.map((oid, index) => [oid, index]));
  objects.sort((a, b) => {
    const rank = typeRank(a.type) - typeRank(b.type);
    if (rank !== 0) return rank;
    if (a.type === 'commit' && b.type === 'commit') {
      const aOid = hashObject(a.type, a.data);
      const bOid = hashObject(b.type, b.data);
      return (commitIndex.get(aOid) ?? 0) - (commitIndex.get(bOid) ?? 0);
    }
    return 0;
  });

  // Shallow boundaries.
  let shallow: string[] = [];
  let unshallow: string[] = [];
  if (args.deepen !== null) {
    const frontier = includedCommits.filter((oid) => {
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') return false;
      const parents = parseCommit(object.data).parents;
      if (parents.length === 0) return true;
      return parents.some((parent) => !includedCommits.includes(parent));
    });
    shallow = frontier;
    unshallow = args.shallows.filter((old) => {
      if (!includedCommits.includes(old)) return false;
      const object = repo.objects.get(old);
      if (object === undefined || object.type !== 'commit') return false;
      return parseCommit(object.data).parents.every((parent) => includedCommits.includes(parent));
    });
  } else if (args.shallows.length > 0) {
    unshallow = [...args.shallows];
  }

  // Acknowledgments.
  let acks: string[] = [];
  let nak = false;
  if (args.haves.length === 0) {
    nak = true;
  } else {
    for (const have of args.haves) {
      if (!repo.objects.has(have)) continue;
      if (args.wants.includes(have)) {
        acks.push(have);
        continue;
      }
      for (const want of args.wants) {
        if (forge.isAncestor(repo, have, want)) {
          acks.push(have);
          break;
        }
      }
    }
    if (acks.length === 0) nak = true;
  }
  acks = [...new Set(acks)];

  return { objects, shallow, unshallow, acks, nak };
}

/** A want oid resolves to its target commit (a tag want resolves through the tag). */
function wantTarget(forge: Forge, repo: Repo, want: string): string | null {
  const object = repo.objects.get(want);
  if (object === undefined) return null;
  if (object.type === 'commit') return want;
  if (object.type === 'tag') return parseTag(object.data).object;
  return null;
}

/** Chunk pack bytes into sideband band-1 pkt-lines (<= 60000 data bytes each). */
function sidebandPackets(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const CHUNK = 60000;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    out.push(encodePktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return out;
}

function parseFetchArgs(lines: readonly string[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallows: [], deepen: null, filter: null };
  for (const raw of lines) {
    const line = raw.replace(/\n$/, '');
    if (line.startsWith('want ')) args.wants.push(line.slice(5).split(' ')[0] as string);
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallows.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const n = Number(line.slice(7).trim());
      if (Number.isFinite(n)) args.deepen = n;
    } else if (line.startsWith('filter ')) args.filter = line.slice(7).trim();
  }
  args.wants = [...new Set(args.wants)];
  return args;
}

function fetchResponseV2(plan: FetchPlan): Buffer {
  const parts: Buffer[] = [];
  parts.push(encodePktLine('acknowledgments\n'));
  if (plan.nak) parts.push(encodePktLine('NAK\n'));
  for (const ack of plan.acks) parts.push(encodePktLine(`ACK ${ack}\n`));
  parts.push(FLUSH_PKT);
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(encodePktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
    parts.push(FLUSH_PKT);
  }
  if (plan.objects.length > 0) {
    const pack = writePack(plan.objects);
    parts.push(encodePktLine('packfile\n'));
    parts.push(...sidebandPackets(pack));
    parts.push(FLUSH_PKT);
  }
  parts.push(FLUSH_PKT);
  return Buffer.concat(parts);
}

function fetchResponseV0(plan: FetchPlan): Buffer {
  const parts: Buffer[] = [];
  if (plan.nak) parts.push(encodePktLine('NAK\n'));
  for (const ack of plan.acks) parts.push(encodePktLine(`ACK ${ack}\n`));
  for (const oid of plan.shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
  if (plan.objects.length > 0) {
    const pack = writePack(plan.objects);
    parts.push(...sidebandPackets(pack));
  }
  parts.push(FLUSH_PKT);
  return Buffer.concat(parts);
}

/** POST /{owner}/{repo}.git/git-upload-pack */
export function handleUploadPack(forge: Forge, res: ServerResponse, owner: string, repoName: string, body: Buffer): void {
  const repo = forge.getRepo(owner, repoName);
  if (repo === undefined) {
    sendError(res, 404, 'Not Found');
    return;
  }
  let lines: string[];
  try {
    const packets = decodePktLines(body);
    lines = packets.filter((packet) => packet.kind === 'data').map((packet) => packet.payload.toString('utf8'));
  } catch {
    sendError(res, 400, 'malformed pkt-line stream');
    return;
  }
  const first = (lines[0] ?? '').replace(/\n$/, '');
  try {
    if (first.startsWith('command=ls-refs')) {
      const prefixes: string[] = [];
      let peel = false;
      let symrefs = false;
      let unborn = false;
      for (const raw of lines.slice(1)) {
        const line = raw.replace(/\n$/, '');
        if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
        else if (line === 'peel') peel = true;
        else if (line === 'symrefs') symrefs = true;
        else if (line === 'unborn') unborn = true;
      }
      sendRaw(res, 200, lsRefsResponse(forge, repo, { prefixes, peel, symrefs, unborn }), UPLOAD_RESULT_CT);
      return;
    }
    if (first.startsWith('command=fetch')) {
      const args = parseFetchArgs(lines.slice(1));
      if (args.wants.length === 0) {
        sendError(res, 400, 'fetch needs a want');
        return;
      }
      const plan = planFetch(forge, repo, args);
      sendRaw(res, 200, fetchResponseV2(plan), UPLOAD_RESULT_CT);
      return;
    }
    if (first.startsWith('want ')) {
      // v0 fetch: wants/shallow/deepen, then haves/done (flush-separated, parsed flat).
      const args = parseFetchArgs(lines);
      if (args.wants.length === 0) {
        sendError(res, 400, 'fetch needs a want');
        return;
      }
      const plan = planFetch(forge, repo, args);
      sendRaw(res, 200, fetchResponseV0(plan), UPLOAD_RESULT_CT);
      return;
    }
    sendError(res, 400, 'unknown upload-pack command');
  } catch (err) {
    sendError(res, 400, err instanceof Error ? err.message : 'upload-pack failed');
  }
}

function lsRefsResponse(
  forge: Forge,
  repo: Repo,
  options: { prefixes: string[]; peel: boolean; symrefs: boolean; unborn: boolean },
): Buffer {
  const parts: Buffer[] = [];
  const matches = (name: string): boolean =>
    options.prefixes.length === 0 || options.prefixes.some((prefix) => name.startsWith(prefix));
  const refs = forge.sortedRefs(repo);
  const tip = headTip(forge, repo);
  if (refs.length === 0) {
    if (matches('HEAD')) parts.push(encodePktLine('unborn HEAD symref-target:refs/heads/main\n'));
  } else {
    if (matches('HEAD') && tip !== undefined) {
      parts.push(
        encodePktLine(options.symrefs ? `${tip} HEAD symref-target:refs/heads/main\n` : `${tip} HEAD\n`),
      );
    }
    for (const ref of refs) {
      if (!matches(ref.name)) continue;
      let line = `${ref.oid} ${ref.name}`;
      if (options.peel && ref.name.startsWith('refs/tags/')) {
        const object = repo.objects.get(ref.oid);
        if (object !== undefined && object.type === 'tag') {
          const target = parseTag(object.data);
          if (target.type === 'commit') line += ` peeled:${target.object}`;
        }
      }
      parts.push(encodePktLine(`${line}\n`));
    }
  }
  parts.push(FLUSH_PKT);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// Receive-pack (push).
// ---------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function pushReport(results: Array<{ ref: string; ok: boolean; reason: string }>, unpackOk: boolean, unpackDetail = 'ok'): Buffer {
  const inner: Buffer[] = [encodePktLine(`unpack ${unpackOk ? 'ok' : unpackDetail}\n`)];
  for (const result of results) {
    inner.push(encodePktLine(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`));
  }
  const outer: Buffer[] = [];
  for (const line of inner) outer.push(encodePktLine(Buffer.concat([Buffer.from([1]), line])));
  outer.push(FLUSH_PKT);
  return Buffer.concat(outer);
}

/** POST /{owner}/{repo}.git/git-receive-pack */
export function handleReceivePack(forge: Forge, res: ServerResponse, owner: string, repoName: string, body: Buffer): void {
  const repo = forge.getRepo(owner, repoName);
  if (repo === undefined) {
    sendError(res, 404, 'Not Found');
    return;
  }
  let commands: PushCommand[] = [];
  let packBytes: Buffer = Buffer.alloc(0);
  try {
    const { lines, rest } = splitAtFlush(body);
    packBytes = rest;
    for (const packet of lines) {
      if (packet.kind !== 'data') continue;
      const text = packet.payload.toString('utf8').replace(/\n$/, '');
      const nul = text.indexOf('\0');
      const commandText = nul >= 0 ? text.slice(0, nul) : text;
      const parts = commandText.split(' ');
      if (parts.length < 3) throw new Error('bad push command line');
      commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts[2] as string });
    }
    if (commands.length === 0) throw new Error('no push commands');
  } catch (err) {
    sendError(res, 400, err instanceof Error ? err.message : 'malformed receive-pack body');
    return;
  }

  // Unpack first: a refused push still unpacks, and the report still says so.
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (packBytes.length > 0) {
    try {
      const read = readPack(packBytes);
      for (const object of read.objects) forge.putObject(repo, object.type, object.data);
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'unpack failed';
    }
  }

  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  for (const command of commands) {
    if (!unpackOk) {
      results.push({ ref: command.ref, ok: false, reason: 'unpack failed' });
      continue;
    }
    const current = repo.refs.get(command.ref);
    if (command.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) {
        results.push({ ref: command.ref, ok: false, reason: 'remote ref does not exist' });
      } else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
        results.push({ ref: command.ref, ok: false, reason: 'old value does not match' });
      } else {
        repo.refs.delete(command.ref);
        results.push({ ref: command.ref, ok: true, reason: '' });
      }
      continue;
    }
    const newObject = repo.objects.get(command.newOid);
    if (newObject === undefined) {
      results.push({ ref: command.ref, ok: false, reason: 'object not found' });
      continue;
    }
    if (command.oldOid === ZERO_OID) {
      // Create.
      if (current !== undefined) {
        results.push({ ref: command.ref, ok: false, reason: 'already exists' });
        continue;
      }
      repo.refs.set(command.ref, command.newOid);
      results.push({ ref: command.ref, ok: true, reason: '' });
      continue;
    }
    // Update: fast-forward only (heads; tags are set directly).
    if (current === undefined) {
      results.push({ ref: command.ref, ok: false, reason: 'remote ref does not exist' });
      continue;
    }
    if (command.oldOid !== current) {
      results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    if (command.ref.startsWith('refs/heads/') && newObject.type === 'commit') {
      if (!forge.isAncestor(repo, current, command.newOid)) {
        results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
    }
    repo.refs.set(command.ref, command.newOid);
    results.push({ ref: command.ref, ok: true, reason: '' });
  }

  sendRaw(res, 200, pushReport(results, unpackOk, unpackDetail), RECEIVE_RESULT_CT);
}
