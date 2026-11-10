import { writeFileSync, mkdirSync } from 'node:fs';
import { MemoryStore } from './store.js';
import { buildSessions, GroundTruth } from './sessions.js';
import { evaluate } from './metrics.js';

const SESSIONS = 20;
const CONSOLIDATE_EVERY = 5;
const K = 5;
const SEED = 7;
const CHANGE_RATE = 0.6; // Mid sweep, where copies of a stale value peak
const TIE_REPEATS = 20; // How many seeds a random tiebreak is averaged over

function runOnce({ forgetPolicy, tiebreak, tieSeed }) {
  const store = new MemoryStore({ forgetPolicy, tiebreak, tieSeed });
  const truth = new GroundTruth();
  const plan = buildSessions({ seed: SEED, sessions: SESSIONS, changeRate: CHANGE_RATE });
  const trace = [];

  for (const session of plan) {
    for (const w of session.writes) {
      store.write(w);
      truth.apply(w);
    }
    if ((session.sessionId + 1) % CONSOLIDATE_EVERY === 0) store.consolidate();
    trace.push({ session: session.sessionId + 1, ...evaluate(store, truth, K) });
  }

  return { trace, stats: store.stats };
}

// A random tiebreak is a coin flip on every query, so one seed is just noise and
// the arm is averaged over several
// The deterministic tiebreaks run once, since repeating them returns the same trace
function runArm({ label, forgetPolicy, tiebreak }) {
  const repeats = tiebreak === 'random' ? TIE_REPEATS : 1;
  const runs = [];
  for (let r = 0; r < repeats; r++) {
    runs.push(runOnce({ forgetPolicy, tiebreak, tieSeed: r + 1 }));
  }

  const trace = runs[0].trace.map((_, i) => {
    const mean = (f) => runs.reduce((s, run) => s + f(run.trace[i]), 0) / runs.length;
    return {
      session: i + 1,
      slots: runs[0].trace[i].slots,
      top1Accuracy: mean((x) => x.top1Accuracy),
      precisionAtK: mean((x) => x.precisionAtK),
      answerFirst: mean((x) => x.answer.first),
      answerLast: mean((x) => x.answer.last),
      activeMemories: runs[0].trace[i].activeMemories,
    };
  });

  return { label, forgetPolicy, tiebreak, repeats, trace, stats: runs[0].stats };
}

const arms = [
  { label: 'none / oldest',    forgetPolicy: 'none',      tiebreak: 'oldest' },
  { label: 'none / random',    forgetPolicy: 'none',      tiebreak: 'random' },
  { label: 'none / recency',   forgetPolicy: 'none',      tiebreak: 'recency' },
  { label: 'supersede/random', forgetPolicy: 'supersede', tiebreak: 'random' },
].map(runArm);

// Print the table
const pct = (x) => `${(x * 100).toFixed(1)}%`.padStart(7);

console.log(
  `\nmini-agent-memory: ${SESSIONS} sessions, consolidate every ${CONSOLIDATE_EVERY}, ` +
  `k=${K}, changeRate=${CHANGE_RATE}, seed=${SEED}\n`
);
console.log('         ' + arms.map((a) => `| ${a.label.padEnd(24)}`).join(''));
console.log(' session ' + arms.map(() => '|   top1     p@5      last').join(''));
console.log('---------' + arms.map(() => '+-------------------------').join(''));

for (let i = 0; i < SESSIONS; i++) {
  const marker = (i + 1) % CONSOLIDATE_EVERY === 0 ? '*' : ' ';
  let row = String(i + 1).padStart(8) + marker;
  for (const arm of arms) {
    const r = arm.trace[i];
    row += `|${pct(r.top1Accuracy)}${pct(r.precisionAtK)}${pct(r.answerLast)} `;
  }
  console.log(row);
}

console.log('\n  * = consolidation ran at the end of this session\n');

for (const arm of arms) {
  const first = arm.trace[0];
  const last = arm.trace.at(-1);
  console.log(
    `${arm.label.padEnd(18)} ` +
    `top1 ${pct(first.top1Accuracy).trim()} -> ${pct(last.top1Accuracy).trim().padStart(6)}   ` +
    `p@${K} ${pct(first.precisionAtK).trim()} -> ${pct(last.precisionAtK).trim().padStart(6)}   ` +
    `last ${pct(first.answerLast).trim()} -> ${pct(last.answerLast).trim().padStart(6)}   ` +
    `memories ${String(last.activeMemories).padStart(3)}`
  );
}
console.log();

mkdirSync(new URL('../results/', import.meta.url), { recursive: true });
writeFileSync(
  new URL('../results/run.json', import.meta.url),
  JSON.stringify({ config: { SESSIONS, CONSOLIDATE_EVERY, K, SEED, TIE_REPEATS }, arms }, null, 2)
);
console.log('raw results -> results/run.json\n');
