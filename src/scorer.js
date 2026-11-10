// Lexical retrieval with no embedding API and no network, so the experiment is
// deterministic and anyone can run it offline
// This is the weak spot of the harness, since a real system would use embeddings
// and might rank a superseded fact differently. See Limits in the README.

const STOP = new Set(['the', 'a', 'an', 'is', 'of', 'for', 'to', 'in', 'on', 'we', 'our']);

export function tokenize(text) {
  return String(text)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t && !STOP.has(t));
}

function termFreq(tokens) {
  const tf = new Map();
  for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
  return tf;
}

// Deterministic hash, used to break ties without lining up with the order the
// memories were written in
function tieHash(seed, id) {
  let h = 2166136261 >>> 0;
  const str = `${seed}:${id}`;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

// Score a query against a corpus of {id, text} docs and return them best first
export function rank(query, docs, { k1 = 1.4, b = 0.75, tiebreak = 'random', tieSeed = 1 } = {}) {
  if (docs.length === 0) return [];

  const docTokens = docs.map((d) => tokenize(d.text));
  const avgLen = docTokens.reduce((s, t) => s + t.length, 0) / docs.length;

  // Count how many docs each term shows up in, since BM25 weighs rare terms higher
  const df = new Map();
  for (const tokens of docTokens) {
    for (const t of new Set(tokens)) df.set(t, (df.get(t) ?? 0) + 1);
  }

  const qTerms = [...new Set(tokenize(query))];
  const N = docs.length;

  const scored = docs.map((doc, i) => {
    const tf = termFreq(docTokens[i]);
    const len = docTokens[i].length;
    let score = 0;

    for (const term of qTerms) {
      const f = tf.get(term);
      if (!f) continue;
      const n = df.get(term) ?? 0;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * len) / avgLen)));
    }

    return { doc, score };
  });

  // Every fact for a slot has the same token length and the same overlap with the
  // query, so they tie on score exactly and the tiebreak alone decides top-1.
  // 'random' uses the seeded hash and is neutral, so top-1 accuracy works out to
  // one over the number of facts held for that slot. 'recency' puts the newest
  // first, which hands the retriever a free hint about which value is current,
  // and that hint is most of what a forgetting policy gives you. 'oldest' is the
  // worst case, kept so the floor is visible.
  // Sorting on the id string is not neutral, since 'm10' sorts before 'm9', which
  // quietly favours the earliest writes. That was the first version of this and it
  // made the failure look worse than it is.
  const cmp = {
    recency: (x, y) => (y.doc.t ?? 0) - (x.doc.t ?? 0),
    oldest: (x, y) => (x.doc.t ?? 0) - (y.doc.t ?? 0),
    random: (x, y) => tieHash(tieSeed, x.doc.id) - tieHash(tieSeed, y.doc.id),
  }[tiebreak];

  if (!cmp) throw new Error(`unknown tiebreak: ${tiebreak}`);

  scored.sort((x, y) => y.score - x.score || cmp(x, y));
  return scored.filter((s) => s.score > 0);
}
