// The step that turns retrieved memories into one answer
// Retrieval precision says what came back, but it does not say what the agent
// concludes, since that depends on how the reader treats a context holding
// several values for the same slot. These are four plain ways it might go, and
// src/validate.js measures which one real models follow.

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
// This was my guess at how a model reads a crowded context and it is wrong.
// Both models tracked the bottom of the list instead, and the cases where
// majority looked right were the ones where the bottom line happened to hold
// the repeated value. Kept because the contrast is the point.
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

// Take whatever sits at the bottom of the list
// This is what both models did on a list of memories that came with no note
// about its order, 59 times out of 60, so it is the measured reader rather
// than a hypothetical one. Retrieval hands back its best guess first, which
// puts its worst guess last, which is the line that gets answered.
function last(cands) {
  if (cands.length === 0) return null;
  return cands[cands.length - 1].value;
}

export const READERS = { first, last, majority, newest };
