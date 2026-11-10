import { tokenize } from './scorer.js';
import { READERS, candidates } from './readers.js';

// Work out whether a memory is a correct and unambiguous answer for the slot
// A fact is correct when its value is the current one. A digest is correct only
// when it names the current value and does not also name a superseded one, since
// a digest listing both gives the retriever no way to choose between them.
export function isCorrect(memory, { subject, predicate }, truth) {
  const current = truth.valueFor(subject, predicate);
  if (current == null) return false;

  if (memory.kind === 'fact') {
    return memory.subject === subject
      && memory.predicate === predicate
      && memory.value === current;
  }

  if (memory.kind === 'digest') {
    if (memory.subject !== subject) return false;
    const tokens = new Set(tokenize(memory.text));
    if (!tokens.has(current)) return false;
    const stale = truth.supersededFor(subject, predicate);
    return !stale.some((v) => tokens.has(v));
  }

  return false;
}

// Query every slot that has been written to and score what comes back
// p@k is reported but it is not the headline, since once a slot holds k or more
// facts and exactly one of them is current, p@k is 1/k whatever the memory does.
// The scores worth reading are the per-reader ones, which ask what the agent
// actually concludes from the context it was handed.
export function evaluate(store, truth, k = 5) {
  const slots = truth.activeSlots();
  const readerNames = Object.keys(READERS);
  let top1Hits = 0;
  let precisionSum = 0;
  const readerHits = Object.fromEntries(readerNames.map((r) => [r, 0]));

  for (const slot of slots) {
    const results = store.recall(`${slot.subject} ${slot.predicate}`, k);
    if (results.length === 0) continue;

    if (isCorrect(results[0], slot, truth)) top1Hits++;

    const correct = results.filter((m) => isCorrect(m, slot, truth)).length;
    precisionSum += correct / results.length;

    const current = truth.valueFor(slot.subject, slot.predicate);
    const cands = candidates(results, slot);
    for (const r of readerNames) {
      if (READERS[r](cands) === current) readerHits[r]++;
    }
  }

  const n = slots.length || 1;
  return {
    slots: slots.length,
    top1Accuracy: top1Hits / n,
    precisionAtK: precisionSum / n,
    answer: Object.fromEntries(readerNames.map((r) => [r, readerHits[r] / n])),
    activeMemories: store.size(),
  };
}
