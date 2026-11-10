import { writeFileSync, mkdirSync } from 'node:fs';
import { MemoryStore } from './store.js';
import { buildSessions, GroundTruth } from './sessions.js';
import { evaluate } from './metrics.js';

// Sweep how often facts change and watch where the last reader breaks
// One seed is noisy, so every point is the mean over SEEDS runs

const SEEDS = 24;
const SESSIONS = 20;
const K = 5;
const CONSOLIDATE_EVERY = 5;
const RATES = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0];

function run({ forgetPolicy, changeRate, seed }) {
  const store = new MemoryStore({ forgetPolicy, tiebreak: 'recency' });
  const truth = new GroundTruth();
  for (const s of buildSessions({ seed, sessions: SESSIONS, changeRate })) {
    for (const w of s.writes) { store.write(w); truth.apply(w); }
    if ((s.sessionId + 1) % CONSOLIDATE_EVERY === 0) store.consolidate();
  }

  // Count how many copies back the current value against its closest rival, so
  // the curve can be read against the thing that drives it
  const tally = new Map();
  for (const m of store.memories) {
    if (!m.active || m.kind !== 'fact') continue;
    const slot = `${m.subject}.${m.predicate}`;
    if (!tally.has(slot)) tally.set(slot, new Map());
    const byValue = tally.get(slot);
    byValue.set(m.value, (byValue.get(m.value) ?? 0) + 1);
  }

  let currentCopies = 0;
  let rivalCopies = 0;
  let slots = 0;
  for (const [slot, byValue] of tally) {
    const [subject, predicate] = slot.split('.');
    const current = truth.valueFor(subject, predicate);
    const rivals = [...byValue.entries()].filter(([v]) => v !== current).map(([, n]) => n);
    currentCopies += byValue.get(current) ?? 0;
    rivalCopies += rivals.length ? Math.max(...rivals) : 0;
    slots++;
  }

  return {
    ...evaluate(store, truth, K),
    currentCopies: currentCopies / slots,
    rivalCopies: rivalCopies / slots,
  };
}

function mean(xs) {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function point(forgetPolicy, changeRate) {
  const runs = [];
  for (let seed = 1; seed <= SEEDS; seed++) runs.push(run({ forgetPolicy, changeRate, seed }));
  return {
    changeRate,
    forgetPolicy,
    first: mean(runs.map((r) => r.answer.first)),
    last: mean(runs.map((r) => r.answer.last)),
    majority: mean(runs.map((r) => r.answer.majority)),
    newest: mean(runs.map((r) => r.answer.newest)),
    precisionAtK: mean(runs.map((r) => r.precisionAtK)),
    currentCopies: mean(runs.map((r) => r.currentCopies)),
    rivalCopies: mean(runs.map((r) => r.rivalCopies)),
  };
}

const none = RATES.map((r) => point('none', r));
const supersede = RATES.map((r) => point('supersede', r));

const pct = (x) => `${(x * 100).toFixed(1)}%`.padStart(7);
const num = (x) => x.toFixed(2).padStart(6);

console.log(`\nAnswer accuracy by how often a fact changes`);
console.log(`${SESSIONS} sessions, k=${K}, recency ranking, mean of ${SEEDS} seeds\n`);
console.log('                      no forgetting                       | supersede');
console.log(' change    first     last  majority   newest  cur/rival | last');
console.log('--------+----------------------------------+-----------+--------');
for (let i = 0; i < RATES.length; i++) {
  const a = none[i];
  const b = supersede[i];
  console.log(
    `  ${a.changeRate.toFixed(2)}  |${pct(a.first)}${pct(a.last)}${pct(a.majority)}${pct(a.newest)} |${num(a.currentCopies)} /${num(a.rivalCopies)} |${pct(b.last)}`
  );
}

const worst = none.reduce((a, b) => (b.last < a.last ? b : a));
console.log(
  `\nWorst for the last reader: changeRate ${worst.changeRate.toFixed(2)} ` +
  `at ${pct(worst.last).trim()}, where the current value holds ` +
  `${worst.currentCopies.toFixed(2)} copies against a rival's ${worst.rivalCopies.toFixed(2)}\n`
);

mkdirSync(new URL('../results/', import.meta.url), { recursive: true });
writeFileSync(
  new URL('../results/sweep.json', import.meta.url),
  JSON.stringify({ config: { SEEDS, SESSIONS, K, CONSOLIDATE_EVERY }, none, supersede }, null, 2)
);
console.log('raw results -> results/sweep.json\n');
