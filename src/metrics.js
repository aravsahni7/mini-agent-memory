import { tokenize } from './scorer.js';

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

// Query every slot that has been written to and work out the two scores
// top-1 asks whether the first result is right, and p@k asks what share of the
// whole batch is right, which is what actually reaches the context window
export function evaluate(store, truth, k = 5) {
  const slots = truth.activeSlots();
  let top1Hits = 0;
  let precisionSum = 0;

  for (const slot of slots) {
    const results = store.recall(`${slot.subject} ${slot.predicate}`, k);
    if (results.length === 0) continue;

    if (isCorrect(results[0], slot, truth)) top1Hits++;

    const correct = results.filter((m) => isCorrect(m, slot, truth)).length;
    precisionSum += correct / results.length;
  }

  const n = slots.length || 1;
  return {
    slots: slots.length,
    top1Accuracy: top1Hits / n,
    precisionAtK: precisionSum / n,
    activeMemories: store.size(),
  };
}
