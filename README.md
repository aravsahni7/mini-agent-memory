# mini-agent-memory

A tiny implementation of the four memory operations described in
[The components of agent memory](https://www.anthropic.com/engineering)
(Anthropic Engineering, Nov 2026), built to test what consolidation without
forgetting does to the answer an agent gives.

Zero dependencies, deterministic, offline. `npm run experiment` and `npm run sweep`
reproduce every number below.

## Finding

**Retrieval looks perfect at every setting. The answer does not.**

Memories are written across 20 sessions. Some writes change a slot's value, the
rest re-affirm the value it already holds, because real agent memory records the
same fact over and over rather than only when something changes. Sweeping how
often a fact actually changes, averaged over 24 seeds:

| change rate | top-ranked | newest | **majority** | copies: current / rival |
|---|---|---|---|---|
| 0.1 | 100% | 100% | **77.4%** | 4.90 / 1.61 |
| 0.3 | 100% | 100% | **52.4%** | 2.81 / 2.81 |
| 0.6 | 100% | 100% | **40.3%** | 1.54 / 2.42 |
| 0.9 | 100% | 100% | **76.7%** | 1.12 / 1.42 |
| 1.0 | 100% | 100% | **100%** | 1.00 / 1.00 |

A reader that takes the top-ranked memory is right every time. So is one that
takes the newest. A reader that weighs the whole retrieved context bottoms out
at 40.3%, and an explicit supersede policy holds it at 100% across the entire
sweep with 24 active memories instead of 128.

The mechanism is in the last column. With no forgetting, every re-affirmation
leaves another copy. A value that was true for a while accumulates copies; the
value that replaced it last week has one or two. At change rate 0.6 the current
value holds 1.54 copies against a rival's 2.42, and the ratio of those two peaks
at exactly the change rate where answer accuracy is worst.

**The worst case is the middle, not the extremes.** Memory is most wrong about
facts that changed recently after a stable period. Slots that never change are
safe because the truth has the most copies. Slots that change constantly are safe
because nothing accumulates. The damage is to facts that were stable long enough
to be repeated and then moved.

None of this is visible to a retrieval metric. Top-1 and newest sit at 100%
across the whole sweep, so an eval asking "did we retrieve the right memory"
reports green at the exact point the agent is most likely to answer wrong.

## Method

- 12 slots (`subject.predicate` → value), 20 sessions, 4 writes per session
- Each write either changes the slot to its next value or re-affirms its current
  one, with `changeRate` controlling the split
- Retrieval is BM25-lite over active memories, `consolidate()` every 5 sessions
- Three readers turn the top 5 retrieved memories into one answer:
  `first` takes the top rank, `newest` takes the highest timestamp, `majority`
  takes the most frequent value with ties broken by rank
- Answer accuracy is the share of slots where the reader returns the current value

## Repro

```
npm run experiment    # four arms over 20 sessions
npm run sweep         # the change-rate curve above
npm test              # 14 assertions covering the harness itself
```

No install step, no API key, Node 18+.

## Three things that were wrong first

All three made the result look better than it was, and all three are easy to repeat:

1. **The scorer tiebroke on recency by default.** Every fact for a slot has
   identical token length and identical query overlap, so they tie on BM25
   exactly and the tiebreak alone decides top-1. With recency baked in, every arm
   scored 100% and the experiment measured nothing.
2. **Sorting ties by memory id looked neutral and was not.** `'m10' < 'm9'`
   lexicographically, so it systematically returned the oldest fact, which is the
   worst case reported as though it were the average.
3. **The first version's headline number was arithmetic, not a result.** It
   reported that precision@5 fell to 20.0% while top-1 held at 100%. But once a
   slot holds five facts and exactly one is current, precision@5 is 1/5 by
   definition. Sweeping k confirmed it: p@k came out to exactly 1/k at every
   value of k. That is why this version measures what the reader concludes
   instead, and why re-affirmation had to be added. Without repeated writes there
   is nothing for a counting reader to get wrong.

The fixture had a fourth problem: slots ran out of values and began rewriting the
value they already held, accumulating correct duplicates and bending the curve
back upward. That one turned out to be worth keeping deliberately, which is what
re-affirmation now is.

## Limits

- **The `majority` reader is a stand-in for an LLM, and an untested one.** The
  claim it encodes is that a model weighs repeated context rather than reading
  rank order, which is plausible and is not measured here. Swap in a real model
  and the curve could flatten entirely. This is the assumption the whole finding
  rests on and the first thing worth attacking.
- **Lexical retrieval, not embeddings.** Values are single tokens of equal length
  so BM25 ties exactly, which keeps the arms comparable but is not how real text
  behaves.
- **A fixed write budget.** 80 writes total, so a higher change rate mechanically
  means fewer repeats. The right-hand end of the curve is partly built in. The
  position and depth of the minimum are not.
- **Synthetic sessions.** Every update is a clean overwrite of one slot, and real
  memory churn is messier and contradicts itself within a session.
- `supersede` assumes a well-formed `(subject, predicate)` key. Extracting that
  reliably from free text is most of the real problem and is skipped here.
