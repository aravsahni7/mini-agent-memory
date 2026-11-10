import { writeFileSync, mkdirSync } from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import { MemoryStore } from './store.js';
import { buildSessions, GroundTruth } from './sessions.js';
import { candidates, READERS } from './readers.js';
import { rng } from './rng.js';

// Check the assumption the whole finding rests on
// The majority reader claims a model weighs repeated context instead of reading
// rank order. That is a guess until a real model is asked, so this builds the
// cases where the two readers disagree and puts them to one.
// On every case here the top-ranked memory holds the current value and a stale
// value appears more often, so 'first' scores 100% and 'majority' scores 0%.
// Whatever a real model scores sits somewhere between the two.

const MODELS = ['claude-opus-5-5', 'claude-haiku-5-5'];
const PRICE = {
  'claude-opus-5-5': { in: 4.0, out: 20.0 },
  'claude-haiku-5-5': { in: 0.1, out: 0.5 },
};
const CHANGE_RATE = 0.6;
const K = 5;
const CONCURRENCY = 4;

const pilot = process.argv.includes('--pilot');
const CASES = pilot ? 2 : 30;

// Collect slots where taking the top rank and counting the context disagree
function buildCases(target) {
  const cases = [];
  for (let seed = 1; cases.length < target && seed <= 400; seed++) {
    const store = new MemoryStore({ forgetPolicy: 'none', tiebreak: 'recency' });
    const truth = new GroundTruth();
    for (const s of buildSessions({ seed, sessions: 20, changeRate: CHANGE_RATE })) {
      for (const w of s.writes) {
        store.write(w);
        truth.apply(w);
      }
      if ((s.sessionId + 1) % 5 === 0) store.consolidate();
    }

    for (const slot of truth.activeSlots()) {
      if (cases.length >= target) break;
      const results = store.recall(`${slot.subject} ${slot.predicate}`, K);
      const cands = candidates(results, slot);
      if (cands.length < 3) continue;

      const current = truth.valueFor(slot.subject, slot.predicate);
      if (READERS.first(cands) !== current) continue;
      const byMajority = READERS.majority(cands);
      if (byMajority === current) continue;

      cases.push({
        id: `s${seed}-${slot.subject}`,
        subject: slot.subject,
        predicate: slot.predicate,
        current,
        majority: byMajority,
        memories: results.map((m) => ({
          text: m.kind === 'digest'
            ? `${m.subject}: ${(m.entries ?? []).map((e) => `${e.predicate} ${e.value}`).join(', ')}`
            : `${m.subject} ${m.predicate} is ${m.value}`,
          t: m.t,
        })),
      });
    }
  }
  return cases;
}

// Four renderings, so repetition can be told apart from position bias
// 'rank' puts the current value at the top but never says the order carries
// meaning, so a model has no way to know position matters. 'labeled' is the
// same list with one line saying it runs newest first, which separates 'cannot
// use the order' from 'ignores the order'. 'shuffled' drops the cue entirely.
// 'stamped' shuffles but shows when each memory was written, which is enough
// to work the answer out.
function render(testCase, condition) {
  let lines = testCase.memories;
  if (condition === 'shuffled' || condition === 'stamped') {
    const next = rng(testCase.id.length * 7919);
    lines = [...lines].sort(() => next() - 0.5);
  }
  const note = condition === 'labeled' ? '(listed newest first)\n' : '';
  return note + lines
    .map((m) => (condition === 'stamped' ? `- [written at t=${m.t}] ${m.text}` : `- ${m.text}`))
    .join('\n');
}

const SYSTEM = "You read an agent's stored memories. Answer only from the memories given. "
  + 'Reply with the value alone: one word, no punctuation, no explanation.';

async function ask(client, model, testCase, condition) {
  const response = await client.messages.create({
    model,
    max_tokens: 2000,
    output_config: { effort: 'low' },
    system: SYSTEM,
    messages: [{
      role: 'user',
      content: `Memories:\n${render(testCase, condition)}\n\n`
        + `What is the current ${testCase.predicate} for ${testCase.subject}?`,
    }],
  });

  const text = response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join(' ')
    .toLowerCase();

  let verdict = 'other';
  if (text.includes(testCase.current)) verdict = 'current';
  else if (text.includes(testCase.majority)) verdict = 'stale';

  return { model, condition, case: testCase.id, verdict, answer: text.trim().slice(0, 40), usage: response.usage };
}

// Run the queue a few at a time, since 180 calls at once invites a 429
async function pool(jobs, limit) {
  const out = [];
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, jobs.length) }, async () => {
      while (i < jobs.length) {
        const mine = i++;
        try {
          out[mine] = await jobs[mine]();
        } catch (err) {
          out[mine] = { error: err?.message ?? String(err) };
        }
      }
    }),
  );
  return out;
}

const client = new Anthropic();
const cases = buildCases(CASES);
const conditions = ['rank', 'labeled', 'shuffled', 'stamped'];
const callCount = cases.length * conditions.length * MODELS.length;

console.log(`\n${pilot ? 'PILOT: ' : ''}${cases.length} conflict cases x ${conditions.length} conditions x ${MODELS.length} models = ${callCount} calls`);
console.log("On every case the top-ranked memory is correct, so 'first' predicts 100% and 'majority' predicts 0%.\n");

const jobs = [];
for (const model of MODELS) {
  for (const condition of conditions) {
    for (const testCase of cases) jobs.push(() => ask(client, model, testCase, condition));
  }
}

// --dry prints what the model would see and stops, so no key and no spend
if (process.argv.includes('--dry')) {
  for (const condition of conditions) {
    console.log('--- ' + condition + ' ---');
    console.log(render(cases[0], condition));
    console.log('\nWhat is the current ' + cases[0].predicate + ' for ' + cases[0].subject + '?');
    console.log('  correct: ' + cases[0].current + '   majority would say: ' + cases[0].majority + '\n');
  }
  process.exit(0);
}

const started = Date.now();
const results = await pool(jobs, CONCURRENCY);
const failed = results.filter((r) => r?.error);
const ok = results.filter((r) => r && !r.error);

if (failed.length) {
  console.log(`${failed.length} call(s) failed. First error: ${failed[0].error}\n`);
  if (!ok.length) process.exit(1);
}

const pct = (n, d) => `${((n / (d || 1)) * 100).toFixed(1)}%`.padStart(8);
console.log('                                  answered with');
console.log(' model                condition   current    stale    other');
console.log('---------------------+-----------+--------+--------+--------');
for (const model of MODELS) {
  for (const condition of conditions) {
    const rows = ok.filter((r) => r.model === model && r.condition === condition);
    if (!rows.length) continue;
    const n = rows.length;
    const c = rows.filter((r) => r.verdict === 'current').length;
    const s = rows.filter((r) => r.verdict === 'stale').length;
    console.log(` ${model.padEnd(21)}${condition.padEnd(11)}${pct(c, n)}${pct(s, n)}${pct(n - c - s, n)}`);
  }
}

let total = 0;
console.log('\n cost');
for (const model of MODELS) {
  const rows = ok.filter((r) => r.model === model);
  if (!rows.length) continue;
  const inTok = rows.reduce((a, r) => a + (r.usage?.input_tokens ?? 0), 0);
  const outTok = rows.reduce((a, r) => a + (r.usage?.output_tokens ?? 0), 0);
  const cost = (inTok / 1e6) * PRICE[model].in + (outTok / 1e6) * PRICE[model].out;
  total += cost;
  console.log(`  ${model.padEnd(20)} ${String(inTok).padStart(7)} in ${String(outTok).padStart(7)} out   $${cost.toFixed(4)}`);
}
console.log(`  ${'TOTAL'.padEnd(20)} ${' '.repeat(22)}$${total.toFixed(4)}`);

if (pilot) {
  const scale = (30 * conditions.length * MODELS.length) / jobs.length;
  console.log(`\n  A full run of 30 cases would be about $${(total * scale).toFixed(2)}, measured rather than estimated.`);
}
console.log(`\n  ${((Date.now() - started) / 1000).toFixed(0)}s elapsed\n`);

mkdirSync(new URL('../results/', import.meta.url), { recursive: true });
const out = pilot ? 'validate-pilot.json' : 'validate.json';
writeFileSync(new URL(`../results/${out}`, import.meta.url), JSON.stringify({ cases, results: ok, failed }, null, 2));
console.log(`raw results -> results/${out}\n`);
