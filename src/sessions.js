import { rng } from './rng.js';

// Every value is a single token, since BM25 normalises for length and a value
// like 'fly.io' would score differently from 'vercel' for reasons that have
// nothing to do with whether it is stale
// Holding the token length constant keeps the measurement clean.
export const SLOTS = [
  { subject: 'deploy',   predicate: 'target',    values: ['vercel', 'railway', 'render', 'netlify', 'heroku', 'flyio', 'cloudrun', 'amplify'] },
  { subject: 'database', predicate: 'engine',    values: ['postgres', 'sqlite', 'mysql', 'duckdb', 'cockroach', 'planetscale', 'neon', 'turso'] },
  { subject: 'auth',     predicate: 'provider',  values: ['clerk', 'authzero', 'supabase', 'firebase', 'okta', 'cognito', 'keycloak', 'stytch'] },
  { subject: 'runtime',  predicate: 'version',   values: ['nodeeighteen', 'nodetwenty', 'nodetwentytwo', 'nodetwentyfour', 'bunone', 'denotwo', 'nodetwentythree', 'buntwo'] },
  { subject: 'styling',  predicate: 'framework', values: ['tailwind', 'panda', 'vanilla', 'stitches', 'emotion', 'unocss', 'linaria', 'sass'] },
  { subject: 'testing',  predicate: 'runner',    values: ['jest', 'vitest', 'mocha', 'bun', 'ava', 'tap', 'jasmine', 'karma'] },
  { subject: 'queue',    predicate: 'backend',   values: ['redis', 'sqs', 'rabbitmq', 'nats', 'kafka', 'bullmq', 'temporal', 'inngest'] },
  { subject: 'logging',  predicate: 'sink',      values: ['datadog', 'axiom', 'betterstack', 'honeycomb', 'splunk', 'loki', 'sentry', 'newrelic'] },
  { subject: 'payments', predicate: 'processor', values: ['stripe', 'paddle', 'lemonsqueezy', 'braintree', 'adyen', 'square', 'checkout', 'mollie'] },
  { subject: 'cache',    predicate: 'layer',     values: ['upstash', 'memcached', 'dragonfly', 'valkey', 'hazelcast', 'varnish', 'keydb', 'infinispan'] },
  { subject: 'search',   predicate: 'index',     values: ['typesense', 'meilisearch', 'algolia', 'elastic', 'opensearch', 'vespa', 'qdrant', 'lucene'] },
  { subject: 'cdn',      predicate: 'edge',      values: ['cloudflare', 'fastly', 'bunny', 'akamai', 'cloudfront', 'keycdn', 'stackpath', 'imperva'] },
];

export const slotKey = (s) => `${s.subject}.${s.predicate}`;

// Build a run of sessions, where each one rewrites a few slots to their next
// value, so the agent's world keeps changing underneath its memory
export function buildSessions({ seed = 7, sessions = 20, writesPerSession = 4 } = {}) {
  const next = rng(seed);
  const total = sessions * writesPerSession;

  // Give every slot a write quota, since sampling them independently hands one
  // slot the tail of the distribution and runs it out of values while the others
  // sit idle. A quota caps every slot at ceil(total / SLOTS.length) instead.
  const perSlot = Math.ceil(total / SLOTS.length);
  if (perSlot > Math.min(...SLOTS.map((s) => s.values.length))) {
    throw new Error(
      `${sessions} sessions x ${writesPerSession} writes needs ${perSlot} values per slot, ` +
      `but the shortest slot has ${Math.min(...SLOTS.map((s) => s.values.length))}`
    );
  }
  if (writesPerSession > SLOTS.length) {
    throw new Error('writesPerSession cannot exceed the number of slots');
  }

  const quota = new Map(SLOTS.map((s) => [slotKey(s), perSlot]));
  const cursor = new Map(SLOTS.map((s) => [slotKey(s), 0]));
  const out = [];

  for (let i = 0; i < sessions; i++) {
    // Spend the largest remaining quotas first and break ties at random, which
    // spreads the writes out without letting any slot run dry
    const candidates = SLOTS
      .filter((s) => quota.get(slotKey(s)) > 0)
      .map((s) => ({ slot: s, q: quota.get(slotKey(s)), r: next() }))
      .sort((a, b) => b.q - a.q || a.r - b.r)
      .slice(0, writesPerSession);

    const writes = candidates.map(({ slot }) => {
      const key = slotKey(slot);
      const at = cursor.get(key);
      // Fail loudly rather than clamping, since a slot that runs out of values
      // starts rewriting the one it already holds, and those correct duplicates
      // push precision back up for reasons that have nothing to do with memory
      if (at >= slot.values.length) {
        throw new Error(`slot ${key} ran out of its ${slot.values.length} values`);
      }
      cursor.set(key, at + 1);
      quota.set(key, quota.get(key) - 1);
      return {
        subject: slot.subject,
        predicate: slot.predicate,
        value: slot.values[at],
        sessionId: i,
      };
    });

    if (writes.length < writesPerSession) {
      throw new Error(`ran out of quota at session ${i}`);
    }

    out.push({ sessionId: i, writes });
  }

  return out;
}

// Replays the writes, so the experiment knows what is actually true at any point
export class GroundTruth {
  constructor() {
    this.current = new Map(); // 'subject.predicate' -> the value it holds now
    this.seen = new Map();    // 'subject.predicate' -> every value it has held
  }

  apply(write) {
    const key = `${write.subject}.${write.predicate}`;
    this.current.set(key, write.value);
    if (!this.seen.has(key)) this.seen.set(key, new Set());
    this.seen.get(key).add(write.value);
  }

  valueFor(subject, predicate) {
    return this.current.get(`${subject}.${predicate}`);
  }

  supersededFor(subject, predicate) {
    const key = `${subject}.${predicate}`;
    const all = this.seen.get(key) ?? new Set();
    const now = this.current.get(key);
    return [...all].filter((v) => v !== now);
  }

  // The slots written at least once, which are the only ones worth querying
  activeSlots() {
    return [...this.current.keys()].map((k) => {
      const [subject, predicate] = k.split('.');
      return { subject, predicate };
    });
  }
}
