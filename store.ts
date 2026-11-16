// The forge's store: scenario identity (a faithful port of the suite's seeded
// generator), the git object model, pack/pkt-line codecs, reachability, and the
// in-memory repository store every surface (git, REST, GraphQL, MCP) shares.
//
// No wall clock and no unseeded randomness in anything sent: commit timestamps
// come from MAKEFUN_TRIAL_NOW (or a fixed epoch) plus a deterministic counter.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

// ---------------------------------------------------------------------------
// Scenario identity: a port of program/env/src/wire.ts (SCENARIO_SEED is the
// contest's fixed data; the suite builds its scenario from the same constant).
// ---------------------------------------------------------------------------

export const SCENARIO_SEED = 0x6a09e667f3bcc909n;
const U64_MASK = (1n << 64n) - 1n;

export function fnv1a64(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & U64_MASK;
  }
  return hash;
}

export function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & U64_MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  return (z ^ (z >> 31n)) & U64_MASK;
}

export function scenarioSeedFor(label: string): bigint {
  return mix64(SCENARIO_SEED ^ fnv1a64(label));
}

export class Rng {
  #state: bigint;
  constructor(seed: bigint) {
    const masked = seed & U64_MASK;
    this.#state = masked === 0n ? SCENARIO_SEED : masked;
  }
  static fromLabel(label: string): Rng {
    return new Rng(scenarioSeedFor(label));
  }
  nextU64(): bigint {
    let x = this.#state;
    x = (x ^ (x >> 12n)) & U64_MASK;
    x = (x ^ (x << 25n)) & U64_MASK;
    x = (x ^ (x >> 27n)) & U64_MASK;
    this.#state = x;
    return (x * 0x2545f4914f6cdd1dn) & U64_MASK;
  }
  nextU32(): number {
    return Number(this.nextU64() >> 32n);
  }
  nextInt(maxExclusive: number): number {
    if (maxExclusive === 1) return 0;
    const range = 4_294_967_296;
    const limit = range - (range % maxExclusive);
    for (;;) {
      const value = this.nextU32();
      if (value < limit) return value % maxExclusive;
    }
  }
  pick<T>(items: readonly T[]): T {
    return items[this.nextInt(items.length)] as T;
  }
}

const FIRST_NAMES: readonly string[] = [
  'ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars',
  'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane',
];
const LAST_NAMES: readonly string[] = [
  'anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller',
  'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber',
  'xu', 'yilmaz', 'zimmer',
];
const REPO_ADJECTIVES: readonly string[] = [
  'amber', 'brisk', 'calm', 'crisp', 'eager', 'faint', 'gentle', 'happy', 'idle', 'jolly', 'keen', 'lively',
  'mellow', 'nimble', 'open', 'plain', 'quick', 'quiet', 'rapid', 'soft', 'steady', 'tidy', 'upbeat',
  'vivid', 'warm', 'witty', 'young', 'zesty',
];
const REPO_NOUNS: readonly string[] = [
  'acorn', 'badger', 'canyon', 'cedar', 'comet', 'coral', 'delta', 'ember', 'falcon', 'glade', 'harbor',
  'indigo', 'juniper', 'kettle', 'lantern', 'meadow', 'nebula', 'orchid', 'pebble', 'quartz', 'raven',
  'saffron', 'thistle', 'umber', 'violet', 'willow', 'yarrow', 'zephyr',
];

export interface ScenarioUser {
  id: number;
  login: string;
  name: string;
  email: string;
}

export function generateUsers(rng: Rng, count: number): ScenarioUser[] {
  const used = new Set<string>();
  const users: ScenarioUser[] = [];
  for (let i = 0; i < Math.max(0, Math.trunc(count)); i += 1) {
    const first = rng.pick(FIRST_NAMES);
    const last = rng.pick(LAST_NAMES);
    const base = `${first}${last}`.replace(/[^a-z0-9-]/g, '');
    let login = base;
    let suffix = 2;
    while (used.has(login)) {
      login = `${base}-${suffix}`;
      suffix += 1;
    }
    used.add(login);
    users.push({ id: 1000 + i, login, name: `${first} ${last}`, email: `${login}@example.invalid` });
  }
  return users;
}

/** The scenario's users and org, recomputed from the fixed seed (never hardcoded). */
export const SCENARIO_USERS: ScenarioUser[] = generateUsers(Rng.fromLabel('users'), 12);
export const VIEWER_USER: ScenarioUser = SCENARIO_USERS[0] as ScenarioUser;
export const TEAMMATE_USER: ScenarioUser = SCENARIO_USERS[1] as ScenarioUser;
export const STRANGER_USER: ScenarioUser = SCENARIO_USERS[2] as ScenarioUser;
export const ORG_NAME: string = (() => {
  const rng = Rng.fromLabel('org');
  return `${rng.pick(REPO_ADJECTIVES)}-${rng.pick(REPO_NOUNS)}-org`;
})();

export const ZERO_OID = '0000000000000000000000000000000000000000';
export const DEFAULT_BRANCH = 'main';

// ---------------------------------------------------------------------------
// Deterministic time: MAKEFUN_TRIAL_NOW (RFC 3339 or epoch ms) or a fixed epoch.
// ---------------------------------------------------------------------------

export function trialNowSec(): number {
  const raw = (process.env.MAKEFUN_TRIAL_NOW ?? '').trim();
  if (raw === '') return 1700000000;
  const asNumber = Number(raw);
  if (Number.isFinite(asNumber) && asNumber > 0) return Math.floor(asNumber >= 1e12 ? asNumber / 1000 : asNumber);
  const parsed = Date.parse(raw);
  if (Number.isFinite(parsed)) return Math.floor(parsed / 1000);
  return 1700000000;
}

// ---------------------------------------------------------------------------
// Git object model (SHA-1 over `<type> <len>\0<bytes>`).
// ---------------------------------------------------------------------------

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjType;
  data: Buffer;
}

export function hashObject(type: ObjType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

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
    if (space < 0) throw new Error('malformed tree: no space');
    const nul = data.indexOf(0, space + 1);
    if (nul < 0 || nul + 21 > data.length) throw new Error('malformed tree: no NUL/oid');
    entries.push({
      mode: data.subarray(offset, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

/** Git's tree sort: entries by name bytes, directories compared as `name/`. */
export function sortTreeEntries(entries: readonly TreeEntry[]): TreeEntry[] {
  const key = (entry: TreeEntry): Buffer =>
    Buffer.from(entry.mode === '40000' ? `${entry.name}/` : entry.name, 'utf8');
  return [...entries].sort((a, b) => Buffer.compare(key(a), key(b)));
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of sortTreeEntries(entries)) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitParts {
  tree: string;
  parents: string[];
  message: string;
  timestamp: number;
  authorName: string;
  authorEmail: string;
}

export function buildCommit(parts: CommitParts): Buffer {
  const lines: string[] = [`tree ${parts.tree}`];
  for (const parent of parts.parents) lines.push(`parent ${parent}`);
  const who = `${parts.authorName} <${parts.authorEmail}> ${parts.timestamp} +0000`;
  lines.push(`author ${who}`);
  lines.push(`committer ${who}`);
  return Buffer.from(`${lines.join('\n')}\n\n${parts.message}\n`, 'utf8');
}

export interface ParsedCommit {
  tree: string;
  parents: string[];
  message: string;
}

export function parseCommit(data: Buffer): ParsedCommit {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2).replace(/\n$/, '');
  let tree = '';
  const parents: string[] = [];
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
  }
  return { tree, parents, message };
}

export function parseTag(data: Buffer): { object: string; type: ObjType; message: string } {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2).replace(/\n$/, '');
  let object = '';
  let type: ObjType = 'commit';
  for (const line of header.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim() as ObjType;
  }
  return { object, type, message };
}

// ---------------------------------------------------------------------------
// Pkt-line codec.
// ---------------------------------------------------------------------------

export const FLUSH_PKT = Buffer.from('0000');
export const DELIM_PKT = Buffer.from('0001');

export function encodePktLine(data: Buffer | string): Buffer {
  const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const len = payload.length + 4;
  const head = Buffer.alloc(4);
  head.write(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, payload]);
}

export type PktKind = 'data' | 'flush' | 'delim' | 'response-end';

export interface PktLine {
  kind: PktKind;
  payload: Buffer;
}

/** Decode a whole buffer of pkt-lines. Throws on a malformed length. */
export function decodePktLines(buf: Buffer): PktLine[] {
  const out: PktLine[] = [];
  let offset = 0;
  while (offset < buf.length) {
    if (offset + 4 > buf.length) throw new Error('pkt-line truncated');
    const lenHex = buf.subarray(offset, offset + 4).toString('ascii');
    const len = parseInt(lenHex, 16);
    if (Number.isNaN(len)) throw new Error(`pkt-line bad length ${JSON.stringify(lenHex)}`);
    if (len === 0) {
      out.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
    } else if (len === 1) {
      out.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
    } else if (len === 2) {
      out.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      offset += 4;
    } else {
      if (offset + len > buf.length) throw new Error('pkt-line truncated');
      out.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + len) });
      offset += len;
    }
  }
  return out;
}

/** Split a buffer at the first flush pkt-line: [lines before it, rest after it]. */
export function splitAtFlush(buf: Buffer): { lines: PktLine[]; rest: Buffer } {
  const lines: PktLine[] = [];
  let offset = 0;
  while (offset < buf.length) {
    if (offset + 4 > buf.length) throw new Error('pkt-line truncated');
    const len = parseInt(buf.subarray(offset, offset + 4).toString('ascii'), 16);
    if (Number.isNaN(len)) throw new Error('pkt-line bad length');
    if (len === 0) return { lines, rest: buf.subarray(offset + 4) };
    if (len < 4 || offset + len > buf.length) throw new Error('pkt-line truncated');
    lines.push({ kind: len === 1 ? 'delim' : len === 2 ? 'response-end' : 'data', payload: buf.subarray(offset + 4, offset + len) });
    offset += len;
  }
  return { lines, rest: Buffer.alloc(0) };
}

// ---------------------------------------------------------------------------
// Pack read/write (plain objects only; the suite's client writes no deltas).
// ---------------------------------------------------------------------------

const PACK_TYPE_IDS: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const PACK_ID_TYPES: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function encodePackObjectHeader(type: ObjType, size: number): Buffer {
  const typeId = PACK_TYPE_IDS[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (typeId << 4) | (remaining & 0x0f);
  remaining >>>= 4;
  if (remaining > 0) first |= 0x80;
  bytes.push(first);
  while (remaining > 0) {
    let byte = remaining & 0x7f;
    remaining >>>= 7;
    if (remaining > 0) byte |= 0x80;
    bytes.push(byte);
  }
  return Buffer.from(bytes);
}

export function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    parts.push(encodePackObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data, { level: 1 }));
  }
  const withoutTrailer = Buffer.concat(parts);
  const trailer = createHash('sha1').update(withoutTrailer).digest();
  return Buffer.concat([withoutTrailer, trailer]);
}

/** The exact byte length of the zlib stream at `start` (inflateSync ignores trailing bytes). */
function zlibStreamLength(buf: Buffer, start: number): number {
  let lo = 1;
  let hi = buf.length - start;
  // Binary search the smallest length that inflates cleanly.
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    try {
      inflateSync(buf.subarray(start, start + mid));
      hi = mid;
    } catch {
      lo = mid + 1;
    }
  }
  // Verify the candidate really inflates; a truncated stream throws.
  inflateSync(buf.subarray(start, start + lo));
  return lo;
}

export interface ReadPackResult {
  objects: GitObject[];
  count: number;
}

/** Parse a packfile, verifying each object's SHA-1 recomputes. Throws on malformed input. */
export function readPack(buf: Buffer): ReadPackResult {
  if (buf.length < 32) throw new Error('pack too small');
  if (buf.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack bad magic');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`pack bad version ${version}`);
  const count = buf.readUInt32BE(8);
  const objects: GitObject[] = [];
  let offset = 12;
  for (let i = 0; i < count; i += 1) {
    if (offset >= buf.length - 20) throw new Error('pack truncated in object header');
    let byte = buf[offset] as number;
    offset += 1;
    const typeId = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while ((byte & 0x80) !== 0) {
      if (offset >= buf.length - 20) throw new Error('pack truncated in size varint');
      byte = buf[offset] as number;
      offset += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    if (typeId === 6 || typeId === 7) throw new Error('pack delta objects are not accepted here');
    const type = PACK_ID_TYPES[typeId];
    if (type === undefined) throw new Error(`pack bad object type ${typeId}`);
    const compLen = zlibStreamLength(buf, offset);
    const data = inflateSync(buf.subarray(offset, offset + compLen));
    offset += compLen;
    if (data.length !== size) throw new Error('pack object size mismatch');
    objects.push({ type, data: Buffer.from(data) });
  }
  if (offset + 20 > buf.length) throw new Error('pack truncated before trailer');
  const trailer = buf.subarray(offset, offset + 20);
  const expected = createHash('sha1').update(buf.subarray(0, offset)).digest();
  if (!trailer.equals(expected)) throw new Error('pack trailer checksum mismatch');
  return { objects, count };
}

// ---------------------------------------------------------------------------
// The store.
// ---------------------------------------------------------------------------

export interface Label {
  name: string;
  color: string;
  description: string;
}

export interface Issue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  createdSeq: number;
  comments: IssueComment[];
}

export interface IssueComment {
  id: number;
  body: string;
}

export interface PullFile {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

export interface Pull {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  files: PullFile[];
  createdSeq: number;
}

export interface Repo {
  owner: string;
  name: string;
  dbId: number;
  description: string | null;
  isPrivate: boolean;
  defaultBranch: string;
  createdSeq: number;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  issues: Issue[];
  pulls: Pull[];
  labels: Map<string, Label>;
  nextNumber: number;
  nextCommentId: number;
}

export function globalId(kind: string, key: string): string {
  return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64');
}

export function repoGlobalId(owner: string, name: string): string {
  return globalId('R', `${owner}/${name}`);
}
export function issueGlobalId(owner: string, name: string, number: number): string {
  return globalId('I', `${owner}/${name}/${number}`);
}
export function pullGlobalId(owner: string, name: string, number: number): string {
  return globalId('PR', `${owner}/${name}/${number}`);
}
export function commentGlobalId(owner: string, name: string, number: number, commentId: number): string {
  return globalId('C', `${owner}/${name}/${number}/${commentId}`);
}

export class Forge {
  readonly token: string;
  viewerLogin: string;
  private repos = new Map<string, Repo>();
  private repoSeq = 0;
  private dbIdSeq = 0;
  private commitClock = 0;
  private readonly baseTs: number;

  constructor(token: string) {
    this.token = token;
    this.viewerLogin = VIEWER_USER.login;
    this.baseTs = trialNowSec();
  }

  /** The next deterministic commit timestamp (base + a per-commit counter). */
  nextCommitTs(): number {
    return this.baseTs + (this.commitClock += 1);
  }

  /** A merged_at timestamp string (deterministic). */
  nextMergedAt(): string {
    return new Date(this.nextCommitTs() * 1000).toISOString();
  }

  static repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(Forge.repoKey(owner, name));
  }

  /** Learn the viewer from an owner that actually owns a repo (insurance for a reseeded trial). */
  learnViewer(owner: string): void {
    if (owner === this.viewerLogin) return;
    for (const repo of this.repos.values()) {
      if (repo.owner === owner) {
        this.viewerLogin = owner;
        return;
      }
    }
  }

  viewerRepos(): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) {
      if (repo.owner === this.viewerLogin) out.push(repo);
    }
    out.sort((a, b) => a.createdSeq - b.createdSeq);
    return out;
  }

  createRepo(owner: string, name: string, options: { description?: string | null; isPrivate?: boolean } = {}): Repo | null {
    const key = Forge.repoKey(owner, name);
    if (this.repos.has(key)) return null;
    this.repoSeq += 1;
    this.dbIdSeq += 1;
    const repo: Repo = {
      owner,
      name,
      dbId: this.dbIdSeq,
      description: options.description ?? null,
      isPrivate: options.isPrivate ?? true,
      defaultBranch: DEFAULT_BRANCH,
      createdSeq: this.repoSeq,
      objects: new Map(),
      refs: new Map(),
      issues: [],
      pulls: [],
      labels: new Map(),
      nextNumber: 1,
      nextCommentId: 1,
    };
    this.repos.set(key, repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(Forge.repoKey(owner, name));
  }

  // -- git objects ---------------------------------------------------------

  putObject(repo: Repo, type: ObjType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  putBlob(repo: Repo, data: Buffer): string {
    return this.putObject(repo, 'blob', data);
  }

  getObject(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  refTip(repo: Repo, ref: string): string | undefined {
    return repo.refs.get(ref);
  }

  setRef(repo: Repo, ref: string, oid: string): void {
    repo.refs.set(ref, oid);
  }

  deleteRef(repo: Repo, ref: string): boolean {
    return repo.refs.delete(ref);
  }

  /** All refs, sorted by name. */
  sortedRefs(repo: Repo): Array<{ name: string; oid: string }> {
    return [...repo.refs.entries()].map(([name, oid]) => ({ name, oid })).sort((a, b) => (a.name < b.name ? -1 : 1));
  }

  /** Branch names (refs/heads/*), sorted. */
  branches(repo: Repo): Array<{ name: string; oid: string }> {
    return this.sortedRefs(repo)
      .filter((ref) => ref.name.startsWith('refs/heads/'))
      .map((ref) => ({ name: ref.name.slice('refs/heads/'.length), oid: ref.oid }));
  }

  /** Resolve a ref-ish: a branch name, a full ref, or a commit oid. */
  resolveRef(repo: Repo, refish: string | undefined): string | undefined {
    if (refish === undefined || refish === '') return repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    if (repo.objects.has(refish) && repo.objects.get(refish)?.type === 'commit') return refish;
    if (refish.startsWith('refs/')) return repo.refs.get(refish);
    return repo.refs.get(`refs/heads/${refish}`);
  }

  /** The commit oids from `tip` newest-first (first-parent walk, visited set). */
  commitHistory(repo: Repo, tip: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const stack: string[] = [tip];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      out.push(oid);
      const parsed = parseCommit(object.data);
      for (let i = parsed.parents.length - 1; i >= 0; i -= 1) stack.push(parsed.parents[i] as string);
    }
    return out;
  }

  /** Every object reachable from `tips` (commits, their trees/blobs, tag targets). */
  reachable(repo: Repo, tips: readonly string[]): Set<string> {
    const out = new Set<string>();
    const stack: string[] = [...tips];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (out.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (object === undefined) continue;
      out.add(oid);
      if (object.type === 'commit') {
        const parsed = parseCommit(object.data);
        stack.push(parsed.tree);
        for (const parent of parsed.parents) stack.push(parent);
      } else if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) stack.push(entry.oid);
      } else if (object.type === 'tag') {
        stack.push(parseTag(object.data).object);
      }
    }
    return out;
  }

  /** Whether `ancestor` is reachable from `descendant` (walk parents). */
  isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    const seen = new Set<string>();
    const stack: string[] = [descendant];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (oid === ancestor) return true;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) stack.push(parent);
    }
    return false;
  }

  /** The merge-base of two commits: the first common ancestor (newest-first walk). */
  mergeBase(repo: Repo, a: string, b: string): string | null {
    const aHistory = this.commitHistory(repo, a);
    const bSet = new Set(this.commitHistory(repo, b));
    for (const oid of aHistory) {
      if (bSet.has(oid)) return oid;
    }
    return null;
  }

  /** The tree oid of a commit. */
  commitTree(repo: Repo, commitOid: string): string | null {
    const object = repo.objects.get(commitOid);
    if (object === undefined || object.type !== 'commit') return null;
    return parseCommit(object.data).tree;
  }

  /** Flatten a tree (recursively) into path -> {oid, mode}. */
  flattenTree(repo: Repo, treeOid: string, prefix = ''): Map<string, { oid: string; mode: string }> {
    const out = new Map<string, { oid: string; mode: string }>();
    const object = repo.objects.get(treeOid);
    if (object === undefined || object.type !== 'tree') return out;
    for (const entry of parseTree(object.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') {
        for (const [childPath, child] of this.flattenTree(repo, entry.oid, path)) out.set(childPath, child);
      } else {
        out.set(path, { oid: entry.oid, mode: entry.mode });
      }
    }
    return out;
  }

  /** Read a file's blob oid at `path` in the tree of `commitOid` (null when absent). */
  fileAt(repo: Repo, commitOid: string, path: string): { oid: string; mode: string } | null {
    const tree = this.commitTree(repo, commitOid);
    if (tree === null) return null;
    return this.flattenTree(repo, tree).get(path) ?? null;
  }

  /** The directory entries at `path` in the tree of `commitOid` (null when not a dir). */
  dirAt(repo: Repo, commitOid: string, path: string): Array<{ name: string; path: string; oid: string; mode: string }> | null {
    const tree = this.commitTree(repo, commitOid);
    if (tree === null) return null;
    const segments = path === '' ? [] : path.split('/');
    let current = tree;
    for (const segment of segments) {
      const object = repo.objects.get(current);
      if (object === undefined || object.type !== 'tree') return null;
      const entry = parseTree(object.data).find((candidate) => candidate.name === segment);
      if (entry === undefined || entry.mode !== '40000') return null;
      current = entry.oid;
    }
    const object = repo.objects.get(current);
    if (object === undefined || object.type !== 'tree') return null;
    return parseTree(object.data).map((entry) => ({
      name: entry.name,
      path: path === '' ? entry.name : `${path}/${entry.name}`,
      oid: entry.oid,
      mode: entry.mode,
    }));
  }

  /** Build a new tree from `baseTree` with `path` set to `blobOid` (creating dirs). */
  treeWithPath(repo: Repo, baseTree: string | null, path: string, blobOid: string): string {
    const segments = path.split('/').filter((segment) => segment !== '');
    const build = (treeOid: string | null, index: number): string => {
      const entries: TreeEntry[] = [];
      if (treeOid !== null) {
        const object = repo.objects.get(treeOid);
        if (object !== undefined && object.type === 'tree') entries.push(...parseTree(object.data));
      }
      const segment = segments[index] as string;
      const kept = entries.filter((entry) => entry.name !== segment);
      if (index === segments.length - 1) {
        kept.push({ mode: '100644', name: segment, oid: blobOid });
      } else {
        const existing = entries.find((entry) => entry.name === segment && entry.mode === '40000');
        const childTree = build(existing?.oid ?? null, index + 1);
        kept.push({ mode: '40000', name: segment, oid: childTree });
      }
      return this.putObject(repo, 'tree', buildTree(kept));
    };
    return build(baseTree, 0);
  }

  /** Build a new tree from `baseTree` with `path` removed (pruning empty dirs). */
  treeWithoutPath(repo: Repo, baseTree: string | null, path: string): string | null {
    const segments = path.split('/').filter((segment) => segment !== '');
    const build = (treeOid: string | null, index: number): string | null => {
      if (treeOid === null) return null;
      const object = repo.objects.get(treeOid);
      if (object === undefined || object.type !== 'tree') return null;
      const entries = parseTree(object.data);
      const segment = segments[index] as string;
      const kept: TreeEntry[] = [];
      for (const entry of entries) {
        if (entry.name !== segment) {
          kept.push(entry);
          continue;
        }
        if (index === segments.length - 1) continue; // drop the file
        if (entry.mode !== '40000') continue;
        const child = build(entry.oid, index + 1);
        if (child !== null) kept.push({ mode: '40000', name: entry.name, oid: child });
      }
      if (kept.length === 0) return null;
      return this.putObject(repo, 'tree', buildTree(kept));
    };
    return build(baseTree, 0);
  }

  /** Create a commit on top of `parent` (or a root commit) with a new tree. */
  makeCommit(repo: Repo, tree: string, parents: string[], message: string): string {
    const data = buildCommit({
      tree,
      parents,
      message,
      timestamp: this.nextCommitTs(),
      authorName: VIEWER_USER.name,
      authorEmail: VIEWER_USER.email,
    });
    return this.putObject(repo, 'commit', data);
  }

  // -- contents ------------------------------------------------------------

  /**
   * PUT /contents: create or update a file on `branch` (creating the branch
   * from the default tip, or the repo's first commit, when needed).
   * Returns {status, commitSha, contentSha} or {error, status}.
   */
  putContent(
    repo: Repo,
    path: string,
    content: Buffer,
    message: string,
    branch: string | undefined,
    sha: string | undefined,
  ): { status: 200 | 201; commitSha: string; contentSha: string } | { status: 409 | 422; message: string } {
    const cleanPath = path.replace(/^\/+/, '').replace(/\/+$/, '');
    const targetBranch = branch ?? repo.defaultBranch;
    let tip = repo.refs.get(`refs/heads/${targetBranch}`);
    if (tip === undefined && branch !== undefined) {
      // Create the branch from the default-branch tip.
      const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      if (defaultTip !== undefined) {
        repo.refs.set(`refs/heads/${targetBranch}`, defaultTip);
        tip = defaultTip;
      }
    }
    const existing = tip === undefined ? null : this.fileAt(repo, tip, cleanPath);
    if (sha !== undefined) {
      if (existing === null || existing.oid !== sha) {
        return { status: 409, message: 'the blob sha does not match the current file' };
      }
    }
    const blobOid = this.putBlob(repo, content);
    const baseTree = tip === undefined ? null : this.commitTree(repo, tip);
    const newTree = this.treeWithPath(repo, baseTree, cleanPath, blobOid);
    const commitSha = this.makeCommit(repo, newTree, tip === undefined ? [] : [tip], message);
    repo.refs.set(`refs/heads/${targetBranch}`, commitSha);
    return { status: existing === null ? 201 : 200, commitSha, contentSha: blobOid };
  }

  /** DELETE /contents: remove a file on the default branch (or `branch`). */
  deleteContent(
    repo: Repo,
    path: string,
    message: string,
    sha: string | undefined,
    branch: string | undefined,
  ): { status: 200; commitSha: string } | { status: 404 | 409; message: string } {
    const cleanPath = path.replace(/^\/+/, '').replace(/\/+$/, '');
    const targetBranch = branch ?? repo.defaultBranch;
    const tip = repo.refs.get(`refs/heads/${targetBranch}`);
    if (tip === undefined) return { status: 404, message: 'Not Found' };
    const existing = this.fileAt(repo, tip, cleanPath);
    if (existing === null) return { status: 404, message: 'Not Found' };
    if (sha !== undefined && existing.oid !== sha) {
      return { status: 409, message: 'the blob sha does not match the current file' };
    }
    const baseTree = this.commitTree(repo, tip);
    const newTree = this.treeWithoutPath(repo, baseTree, cleanPath);
    const emptyTree = this.putObject(repo, 'tree', buildTree([]));
    const commitSha = this.makeCommit(repo, newTree ?? emptyTree, [tip], message);
    repo.refs.set(`refs/heads/${targetBranch}`, commitSha);
    return { status: 200, commitSha };
  }

  // -- issues / pulls ------------------------------------------------------

  createIssue(repo: Repo, title: string, body: string, labels: string[]): Issue | { error: string } {
    for (const label of labels) {
      if (!repo.labels.has(label)) return { error: `label ${label} does not exist` };
    }
    const issue: Issue = {
      number: repo.nextNumber,
      title,
      body,
      state: 'open',
      labels: [...labels],
      createdSeq: repo.nextNumber,
      comments: [],
    };
    repo.nextNumber += 1;
    repo.issues.push(issue);
    return issue;
  }

  findIssue(repo: Repo, number: number): Issue | undefined {
    return repo.issues.find((issue) => issue.number === number);
  }

  findPull(repo: Repo, number: number): Pull | undefined {
    return repo.pulls.find((pull) => pull.number === number);
  }

  /** The line diff between two blobs (multiset-based, deterministic). */
  static diffBlobs(oldData: Buffer | null, newData: Buffer | null): { additions: number; deletions: number } {
    const oldLines = oldData === null ? [] : oldData.toString('utf8').split('\n');
    const newLines = newData === null ? [] : newData.toString('utf8').split('\n');
    const count = (lines: string[]): Map<string, number> => {
      const map = new Map<string, number>();
      for (const line of lines) map.set(line, (map.get(line) ?? 0) + 1);
      return map;
    };
    const oldCount = count(oldLines);
    const newCount = count(newLines);
    let additions = 0;
    let deletions = 0;
    for (const [line, n] of newCount) additions += Math.max(0, n - (oldCount.get(line) ?? 0));
    for (const [line, n] of oldCount) deletions += Math.max(0, n - (newCount.get(line) ?? 0));
    return { additions, deletions };
  }

  /** The files changed between the base and head commits of a pull request. */
  pullFiles(repo: Repo, baseSha: string, headSha: string): PullFile[] {
    const baseTree = this.commitTree(repo, baseSha);
    const headTree = this.commitTree(repo, headSha);
    const baseFiles = baseTree === null ? new Map() : this.flattenTree(repo, baseTree);
    const headFiles = headTree === null ? new Map() : this.flattenTree(repo, headTree);
    const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
    const out: PullFile[] = [];
    for (const path of [...paths].sort()) {
      const base = baseFiles.get(path);
      const head = headFiles.get(path);
      if (base !== undefined && head !== undefined && base.oid === head.oid) continue;
      if (base === undefined && head !== undefined) {
        const data = repo.objects.get(head.oid)?.data ?? null;
        const { additions, deletions } = Forge.diffBlobs(null, data);
        out.push({ filename: path, status: 'added', additions: Math.max(1, additions), deletions, changes: additions + deletions });
      } else if (base !== undefined && head === undefined) {
        const data = repo.objects.get(base.oid)?.data ?? null;
        const { additions, deletions } = Forge.diffBlobs(data, null);
        out.push({ filename: path, status: 'removed', additions, deletions: Math.max(0, deletions), changes: additions + deletions });
      } else if (base !== undefined && head !== undefined) {
        const oldData = repo.objects.get(base.oid)?.data ?? null;
        const newData = repo.objects.get(head.oid)?.data ?? null;
        const { additions, deletions } = Forge.diffBlobs(oldData, newData);
        out.push({
          filename: path,
          status: 'modified',
          additions: Math.max(1, additions),
          deletions,
          changes: additions + deletions,
        });
      }
    }
    return out;
  }

  createPull(repo: Repo, title: string, body: string, headRef: string, baseRef: string): Pull | { error: string } {
    const headSha = repo.refs.get(`refs/heads/${headRef}`);
    const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
    if (headSha === undefined) return { error: `head branch ${headRef} does not exist` };
    if (baseSha === undefined) return { error: `base branch ${baseRef} does not exist` };
    const pull: Pull = {
      number: repo.nextNumber,
      title,
      body,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef,
      baseRef,
      headSha,
      baseSha,
      files: this.pullFiles(repo, baseSha, headSha),
      createdSeq: repo.nextNumber,
    };
    repo.nextNumber += 1;
    repo.pulls.push(pull);
    return pull;
  }

  /** Whether merging `pull` would conflict (same path changed differently on both sides). */
  pullConflicts(repo: Repo, pull: Pull): boolean {
    const base = this.mergeBase(repo, pull.headSha, pull.baseSha);
    if (base === null) return pull.headSha !== pull.baseSha;
    const baseTree = this.commitTree(repo, base);
    const headTree = this.commitTree(repo, pull.headSha);
    const baseTipTree = this.commitTree(repo, pull.baseSha);
    const baseFiles = baseTree === null ? new Map() : this.flattenTree(repo, baseTree);
    const headFiles = headTree === null ? new Map() : this.flattenTree(repo, headTree);
    const tipFiles = baseTipTree === null ? new Map() : this.flattenTree(repo, baseTipTree);
    const paths = new Set([...baseFiles.keys(), ...headFiles.keys(), ...tipFiles.keys()]);
    for (const path of paths) {
      const b = baseFiles.get(path)?.oid;
      const h = headFiles.get(path)?.oid;
      const t = tipFiles.get(path)?.oid;
      const headChanged = h !== b;
      const tipChanged = t !== b;
      if (headChanged && tipChanged && h !== t) return true;
    }
    return false;
  }

  /** Squash-merge `pull` onto its base branch. Returns the merge commit sha or an error. */
  mergePull(repo: Repo, pull: Pull): { status: 200; sha: string } | { status: 405 | 404; message: string } {
    if (pull.state !== 'open') return { status: 405, message: 'the pull request is not open' };
    const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
    if (baseTip === undefined) return { status: 404, message: 'Not Found' };
    // Refresh the head/base tips from the live refs.
    const headTip = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
    const livePull: Pull = { ...pull, headSha: headTip, baseSha: baseTip };
    if (this.pullConflicts(repo, livePull)) return { status: 405, message: 'the pull request cannot be merged: conflicting files' };
    const base = this.mergeBase(repo, headTip, baseTip);
    const baseFiles = base === null ? new Map() : this.flattenTree(repo, this.commitTree(repo, base) ?? '');
    const headFiles = this.flattenTree(repo, this.commitTree(repo, headTip) ?? '');
    const tipFiles = this.flattenTree(repo, this.commitTree(repo, baseTip) ?? '');
    // Merged tree: start from the base tip, apply the head side's changes.
    let treeOid = this.commitTree(repo, baseTip) ?? this.putObject(repo, 'tree', buildTree([]));
    const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
    // Apply removals and changes one path at a time (rebuild the tree per path is
    // O(paths x tree) but pull fixtures are small; the bench never merges).
    const merged = new Map<string, { oid: string; mode: string }>(tipFiles);
    for (const path of paths) {
      const b = baseFiles.get(path)?.oid;
      const h = headFiles.get(path)?.oid;
      if (h === b) continue;
      if (h === undefined) merged.delete(path);
      else merged.set(path, headFiles.get(path) as { oid: string; mode: string });
    }
    // Rebuild the full tree from the merged flat map.
    treeOid = this.buildTreeFromFlat(repo, merged);
    const sha = this.makeCommit(repo, treeOid, [baseTip], `Merge pull request #${pull.number}: ${pull.title}`);
    repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = this.nextMergedAt();
    pull.mergeCommitSha = sha;
    pull.baseSha = sha;
    return { status: 200, sha };
  }

  /** Rebuild a nested tree from a flat path -> blob map. */
  buildTreeFromFlat(repo: Repo, flat: Map<string, { oid: string; mode: string }>): string {
    interface Node {
      files: Map<string, { oid: string; mode: string }>;
      dirs: Map<string, Node>;
    }
    const root: Node = { files: new Map(), dirs: new Map() };
    for (const [path, entry] of flat) {
      const segments = path.split('/');
      let node = root;
      for (let i = 0; i < segments.length - 1; i += 1) {
        const segment = segments[i] as string;
        let child = node.dirs.get(segment);
        if (child === undefined) {
          child = { files: new Map(), dirs: new Map() };
          node.dirs.set(segment, child);
        }
        node = child;
      }
      node.files.set(segments[segments.length - 1] as string, entry);
    }
    const build = (node: Node): string => {
      const entries: TreeEntry[] = [];
      for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
      return this.putObject(repo, 'tree', buildTree(entries));
    };
    return build(root);
  }
}
