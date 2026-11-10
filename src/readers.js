// The step that turns retrieved memories into one answer
// Retrieval precision says what came back, but it does not say what the agent
// concludes, since that depends on how the reader treats a context holding
// several values for the same slot. These are three plain ways it might go.

// Pull every value the retrieved memories offer for this slot, best rank first
export function candidates(results, { subject, predicate }) {
  const out = [];
  for (const m of results) {
    if (m.subject !== subject) continue;
    if (m.kind === 'fact' && m.predicate === predicate) {
      out.push({ value: m.value, t: m.t });
    } else if (m.kind === 'digest') {
      for (const e of m.entries ?? []) {
        if (e.predicate === predicate) out.push({ value: e.value, t: m.t });
      }
    }
  }
  return out;
}

// Trust the ranking and take the top one, which is what a short prompt does
function first(cands) {
  return cands[0]?.value ?? null;
}

// Go with whatever the context says most often, ties broken by rank
// This is the one that models a reader swayed by repetition rather than order
function majority(cands) {
  if (cands.length === 0) return null;
  const counts = new Map();
  for (const c of cands) counts.set(c.value, (counts.get(c.value) ?? 0) + 1);
  let best = null;
  let bestCount = -1;
  for (const c of cands) {
    const n = counts.get(c.value);
    if (n > bestCount) {
      best = c.value;
      bestCount = n;
    }
  }
  return best;
}

// Take whichever value was written most recently, which needs the memories to
// carry timestamps the reader can actually see
function newest(cands) {
  if (cands.length === 0) return null;
  return cands.reduce((a, b) => (b.t > a.t ? b : a)).value;
}

export const READERS = { first, majority, newest };
