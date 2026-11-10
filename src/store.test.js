import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from './store.js';
import { rank } from './scorer.js';
import { buildSessions, SLOTS, slotKey } from './sessions.js';
import { GroundTruth } from './sessions.js';
import { isCorrect } from './metrics.js';
import { READERS, candidates } from './readers.js';

test('supersede retires the previous value for a slot', () => {
  const s = new MemoryStore({ forgetPolicy: 'supersede' });
  s.write({ subject: 'deploy', predicate: 'target', value: 'vercel', sessionId: 0 });
  s.write({ subject: 'deploy', predicate: 'target', value: 'railway', sessionId: 1 });
  const active = s.memories.filter((m) => m.active);
  assert.equal(active.length, 1);
  assert.equal(active[0].value, 'railway');
});

test('no-forget keeps every value ever written', () => {
  const s = new MemoryStore({ forgetPolicy: 'none' });
  s.write({ subject: 'deploy', predicate: 'target', value: 'vercel', sessionId: 0 });
  s.write({ subject: 'deploy', predicate: 'target', value: 'railway', sessionId: 1 });
  assert.equal(s.size(), 2);
  assert.equal(s.stats.evicted, 0);
});

test('supersede does not touch a different predicate on the same subject', () => {
  const s = new MemoryStore({ forgetPolicy: 'supersede' });
  s.write({ subject: 'deploy', predicate: 'target', value: 'vercel', sessionId: 0 });
  s.write({ subject: 'deploy', predicate: 'region', value: 'iad', sessionId: 0 });
  s.write({ subject: 'deploy', predicate: 'target', value: 'railway', sessionId: 1 });
  const values = s.memories.filter((m) => m.active).map((m) => m.value).sort();
  assert.deepEqual(values, ['iad', 'railway']);
});

test('a digest over unforgotten facts is ambiguous and scores as wrong', () => {
  const s = new MemoryStore({ forgetPolicy: 'none' });
  const truth = new GroundTruth();
  for (const v of ['vercel', 'railway']) {
    const w = { subject: 'deploy', predicate: 'target', value: v, sessionId: 0 };
    s.write(w);
    truth.apply(w);
  }
  s.consolidate();
  const digest = s.memories.find((m) => m.kind === 'digest');
  assert.ok(digest.text.includes('vercel') && digest.text.includes('railway'));
  assert.equal(isCorrect(digest, { subject: 'deploy', predicate: 'target' }, truth), false);
});

test('a digest over superseded facts names only the current value', () => {
  const s = new MemoryStore({ forgetPolicy: 'supersede' });
  const truth = new GroundTruth();
  for (const v of ['vercel', 'railway']) {
    const w = { subject: 'deploy', predicate: 'target', value: v, sessionId: 0 };
    s.write(w);
    truth.apply(w);
  }
  s.consolidate();
  const digest = s.memories.find((m) => m.kind === 'digest');
  assert.ok(!digest.text.includes('vercel'));
  assert.equal(isCorrect(digest, { subject: 'deploy', predicate: 'target' }, truth), true);
});

test('facts for one slot tie on score, so the tiebreak alone picks top-1', () => {
  const docs = [
    { id: 'm1', t: 1, text: 'deploy target vercel' },
    { id: 'm2', t: 2, text: 'deploy target railway' },
    { id: 'm3', t: 3, text: 'deploy target render' },
  ];
  const scores = rank('deploy target', docs, { tiebreak: 'recency' }).map((s) => s.score);
  assert.ok(Math.max(...scores) - Math.min(...scores) < 1e-9, 'scores should tie exactly');
  assert.equal(rank('deploy target', docs, { tiebreak: 'recency' })[0].doc.id, 'm3');
  assert.equal(rank('deploy target', docs, { tiebreak: 'oldest' })[0].doc.id, 'm1');
});

test('fixture values are single tokens, so BM25 length norm cannot skew arms', () => {
  for (const slot of SLOTS) {
    for (const v of slot.values) {
      const tokens = v.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
      assert.equal(tokens.length, 1, `${slotKey(slot)} value "${v}" is not a single token`);
    }
  }
});

test('no slot uses more distinct values than it has', () => {
  // Writes may exceed the value count now, since a re-affirmation rewrites the
  // value the slot already holds rather than taking a new one
  const plan = buildSessions({ seed: 7, sessions: 20, writesPerSession: 4 });
  const used = new Map();
  for (const s of plan) {
    for (const w of s.writes) {
      const k = `${w.subject}.${w.predicate}`;
      if (!used.has(k)) used.set(k, new Set());
      used.get(k).add(w.value);
    }
  }
  for (const slot of SLOTS) {
    const n = used.get(slotKey(slot))?.size ?? 0;
    assert.ok(n <= slot.values.length, `${slotKey(slot)}: ${n} distinct > ${slot.values.length}`);
  }
});

test('the first write to a slot introduces a value rather than re-affirming', () => {
  const plan = buildSessions({ seed: 3, sessions: 20, changeRate: 0.1 });
  const seen = new Set();
  for (const s of plan) {
    for (const w of s.writes) {
      const k = `${w.subject}.${w.predicate}`;
      if (!seen.has(k)) {
        assert.equal(w.change, true, `first write to ${k} should be a change`);
        seen.add(k);
      }
    }
  }
});

test('a lower change rate piles up more copies of one value', () => {
  const copies = (changeRate) => {
    const counts = new Map();
    for (const s of buildSessions({ seed: 7, sessions: 20, changeRate })) {
      for (const w of s.writes) {
        const k = `${w.subject}.${w.predicate}=${w.value}`;
        counts.set(k, (counts.get(k) ?? 0) + 1);
      }
    }
    return Math.max(...counts.values());
  };
  assert.ok(copies(0.2) > copies(0.9), 'rarely-changing slots should repeat values more');
});

test('majority flips to a stale value when the old one was re-affirmed more', () => {
  const results = [
    { kind: 'fact', subject: 'deploy', predicate: 'target', value: 'railway', t: 50 },
    { kind: 'fact', subject: 'deploy', predicate: 'target', value: 'vercel', t: 3 },
    { kind: 'fact', subject: 'deploy', predicate: 'target', value: 'vercel', t: 7 },
  ];
  const cands = candidates(results, { subject: 'deploy', predicate: 'target' });
  assert.equal(READERS.first(cands), 'railway');
  assert.equal(READERS.newest(cands), 'railway');
  assert.equal(READERS.majority(cands), 'vercel');
});

test('readers pull values out of a digest as well as plain facts', () => {
  const results = [
    {
      kind: 'digest',
      subject: 'deploy',
      t: 9,
      entries: [{ predicate: 'target', value: 'vercel' }, { predicate: 'region', value: 'iad' }],
    },
  ];
  const cands = candidates(results, { subject: 'deploy', predicate: 'target' });
  assert.deepEqual(cands.map((c) => c.value), ['vercel']);
});

test('every reader abstains rather than guessing when nothing matches', () => {
  const cands = candidates([], { subject: 'deploy', predicate: 'target' });
  for (const [name, read] of Object.entries(READERS)) {
    assert.equal(read(cands), null, `${name} should return null`);
  }
});

test('a session never writes the same slot twice', () => {
  for (const s of buildSessions({ seed: 7, sessions: 20 })) {
    const keys = s.writes.map((w) => `${w.subject}.${w.predicate}`);
    assert.equal(new Set(keys).size, keys.length, `session ${s.sessionId} repeats a slot`);
  }
});

test('the last reader takes the bottom of the list, not the best-ranked value', () => {
  const results = [
    { kind: 'fact', subject: 'deploy', predicate: 'target', value: 'vercel', t: 9 },
    { kind: 'fact', subject: 'deploy', predicate: 'target', value: 'fly', t: 5 },
    { kind: 'fact', subject: 'deploy', predicate: 'target', value: 'railway', t: 2 },
  ];
  const cands = candidates(results, { subject: 'deploy', predicate: 'target' });
  assert.equal(READERS.first(cands), 'vercel');
  assert.equal(READERS.last(cands), 'railway');
});

test('last and majority come apart, since the bottom line is not the common one', () => {
  // this is the shape that told the two apart, because a reader counting copies
  // says fly and a reader taking the bottom says railway
  const results = [
    { kind: 'fact', subject: 'queue', predicate: 'backend', value: 'nats', t: 9 },
    { kind: 'fact', subject: 'queue', predicate: 'backend', value: 'fly', t: 7 },
    { kind: 'fact', subject: 'queue', predicate: 'backend', value: 'fly', t: 5 },
    { kind: 'fact', subject: 'queue', predicate: 'backend', value: 'railway', t: 2 },
  ];
  const cands = candidates(results, { subject: 'queue', predicate: 'backend' });
  assert.equal(READERS.majority(cands), 'fly');
  assert.equal(READERS.last(cands), 'railway');
  assert.notEqual(READERS.majority(cands), READERS.last(cands));
});
