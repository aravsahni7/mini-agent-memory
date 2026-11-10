# mini-agent-memory

A tiny implementation of the four memory operations described in
[The components of agent memory](https://www.anthropic.com/engineering)
(Anthropic Engineering, Nov 2026), built to test one claim: **what happens to
retrieval when memory is consolidated but never forgotten.**

Zero dependencies. Deterministic. `npm run experiment` reproduces every number below.

## Finding

Adding recency to the ranker makes the failure invisible at top-1 while leaving it
fully intact in the context window.

Over 20 sessions with 80 fact updates across 12 slots, consolidating every 5 sessions:

| forgetting | tiebreak | top-1 @ s1 → s20 | p@5 @ s1 → s20 | memories | evicted |
|---|---|---|---|---|---|
| none | oldest | 100% → **0.0%** | 100% → **0.0%** | 128 | 0 |
| none | random | 100% → **11.3%** | 100% → **15.6%** | 128 | 0 |
| none | recency | 100% → **100%** | 100% → **20.0%** | 128 | 0 |
| supersede | random | 100% → **100%** | 100% → **100%** | 24 | 104 |

The third row is the interesting one. Recency ranking restores top-1 to a perfect
score, so any eval that checks "did it retrieve the right fact" reports green. But
p@5 sits at 20.0% — exactly 1 correct memory in 5. The other four are superseded
values for the same slot, and they still go into the context window.

So recency weighting is not a cheap substitute for a forgetting policy. It relocates
the problem from *retrieval* to *context*, where it is harder to see: the agent gets
the right answer ranked first and four contradictions ranked just behind it.

Eviction also kept the store at 24 active memories instead of 128 — a 5.3× difference
in what has to be ranked on every call.

### Why consolidation makes it worse, not better

`consolidate()` collapses a subject's active facts into one digest. With no forgetting,
"active" still includes every superseded value, so the digest reads:

```
deploy target vercel and target railway and target render
```

That is a single high-scoring memory that encodes the ambiguity permanently, and it
survives into every later retrieval. The sawtooth in the `oldest` column at sessions
5/10/15/20 is consolidation firing.

## Method

- 12 slots (`subject.predicate` → value), each updated 6–7 times over 20 sessions
- Retrieval is BM25-lite over active memories; `consolidate()` every 5 sessions
- **top-1**: is the highest-ranked memory the currently-true value?
- **p@5**: what fraction of the top 5 are currently true? A digest naming both a
  current and a superseded value counts as wrong — the retriever has no way to choose.
- Random tiebreaks averaged over 20 seeds; deterministic ones run once

## Repro

```
git clone <this repo> && cd mini-agent-memory
npm run experiment    # table above, plus results/run.json
npm test              # 9 assertions covering the harness itself
```

No install step. No API key. Node 18+.

## Two bugs this went through

Both inflated the result, and both are worth naming because they are easy to repeat:

1. **The scorer tiebroke on recency by default.** Every fact for a slot has identical
   token length and identical query overlap, so they tie on BM25 *exactly* and the
   tiebreak alone decides top-1. With recency baked in, both arms scored 100% and the
   experiment was measuring nothing. Recency is now one arm of four.
2. **Sorting ties by memory id looked neutral and was not.** `'m10' < 'm9'`
   lexicographically, so it systematically returned the oldest fact — the worst case,
   reported as if it were the average. The real neutral baseline is a seeded hash,
   which puts the no-forgetting arm at 11.3%, not 0%.

The fixture had a third problem: slots ran out of values and began rewriting the value
they already held, accumulating *correct* duplicates and bending the precision curve
back upward. `buildSessions` now allocates an explicit per-slot quota and throws rather
than clamping.

## Limits

- **Lexical retrieval, not embeddings.** Embeddings would not tie so exactly, so the
  tiebreak would matter less and the no-forgetting arm would likely land above 11.3%.
  The recency-vs-p@5 gap should survive, but this is the assumption most worth attacking.
- **Synthetic sessions**, not real agent traces. Every update is a clean overwrite of a
  single slot; real memory churn is messier and partly contradictory within a session.
- **One consolidation strategy** (concatenate per subject). A digest that resolved
  conflicts at write time would behave differently — arguably that *is* a forgetting
  policy wearing a different hat.
- `supersede` assumes a well-formed `(subject, predicate)` key. Extracting that
  reliably from free text is most of the real problem and is skipped entirely here.
