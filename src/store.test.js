import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from './store.js';
import { rank } from './scorer.js';
import { buildSessions, SLOTS, slotKey } from './sessions.js';
import { GroundTruth } from './sessions.js';
import { isCorrect } from './metrics.js';

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

test('no slot is written more times than it has values', () => {
  const plan = buildSessions({ seed: 7, sessions: 20, writesPerSession: 4 });
  const counts = new Map();
  for (const s of plan) {
    for (const w of s.writes) {
      const k = `${w.subject}.${w.predicate}`;
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
  }
  for (const slot of SLOTS) {
    const n = counts.get(slotKey(slot)) ?? 0;
    assert.ok(n <= slot.values.length, `${slotKey(slot)}: ${n} writes > ${slot.values.length} values`);
  }
});

test('a session never writes the same slot twice', () => {
  for (const s of buildSessions({ seed: 7, sessions: 20 })) {
    const keys = s.writes.map((w) => `${w.subject}.${w.predicate}`);
    assert.equal(new Set(keys).size, keys.length, `session ${s.sessionId} repeats a slot`);
  }
});
