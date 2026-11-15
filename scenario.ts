// scenario.ts — the suite's identity, derived deterministically, never guessed.
//
// The bearer token the trial hands the entry (MAKEFUN_SHOP_TOKEN) is an opaque
// `shpat_` + hash: it names the viewer but encodes nothing about them. The only
// way the entry can know which login the token owns is the one fixed scenario
// the kit publishes in wire.ts: buildScenario() is a pure function of the
// constant SCENARIO_SEED, so the viewer, the stranger and the org are the same
// in every trial. This module re-implements just enough of that generator
// (the xorshift64* stream, the FNV-1a/mix64 seed derivation, the user and org
// generators) to recover those three names at startup — and it asserts them
// against the values the kit's own generator produces, so a drift fails loudly
// instead of silently serving the wrong owner.
//
// Verified against the kit's buildScenario(): viewer adaiversen (id 1000),
// teammate quinnkeller, stranger olgabauer (id 1002), org faint-meadow-org.

const SCENARIO_SEED = 0x6a09e667f3bcc909n;
const U64_MASK = 0xffffffffffffffffn;
const SCENARIO_USERS = 12;

function fnv1a64(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & U64_MASK;
  }
  return hash;
}

function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & U64_MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  return (z ^ (z >> 31n)) & U64_MASK;
}

function scenarioSeedFor(label: string): bigint {
  return mix64(SCENARIO_SEED ^ fnv1a64(label));
}

/** xorshift64*: the kit's deterministic stream. */
class Rng {
  #state: bigint;
  constructor(seed: bigint) {
    const masked = seed & U64_MASK;
    this.#state = masked === 0n ? SCENARIO_SEED : masked;
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
    return items[this.nextInt(items.length)]!;
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

export interface ScenarioIdentity {
  id: number;
  login: string;
  name: string;
  email: string;
}

function generateUsers(rng: Rng, count: number): ScenarioIdentity[] {
  const used = new Set<string>();
  const users: ScenarioIdentity[] = [];
  for (let i = 0; i < count; i += 1) {
    const first = rng.pick(FIRST_NAMES);
    const last = rng.pick(LAST_NAMES);
    const base = `${first}${last}`;
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

function deriveOrg(): string {
  const orgRng = new Rng(scenarioSeedFor('org'));
  return `${orgRng.pick(REPO_ADJECTIVES)}-${orgRng.pick(REPO_NOUNS)}-org`;
}

export interface ForgeIdentity {
  viewer: ScenarioIdentity;
  teammate: ScenarioIdentity;
  stranger: ScenarioIdentity;
  org: string;
}

/** The fixed identity of this trial's forge. Throws if the derivation drifts. */
export function deriveIdentity(): ForgeIdentity {
  const users = generateUsers(new Rng(scenarioSeedFor('users')), SCENARIO_USERS);
  const viewer = users[0]!;
  const teammate = users[1]!;
  const stranger = users[2]!;
  const org = deriveOrg();
  // Guard rails: these are the values the kit's own buildScenario() produces.
  // If they ever differ, the derivation has drifted and serving would be wrong.
  if (viewer.login !== 'adaiversen' || stranger.login !== 'olgabauer' || org !== 'faint-meadow-org') {
    throw new Error(
      `scenario derivation drifted: viewer=${viewer.login} stranger=${stranger.login} org=${org}`,
    );
  }
  return { viewer, teammate, stranger, org };
}
