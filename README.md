# mini-agent-memory

**Inspired by [The components of agent memory](https://www.anthropic.com/research/components-of-agent-memory)**, Lance Martin, Anthropic, 6 Nov 2026.

A tiny implementation of a write, recall, consolidate and forget loop, built to
test what consolidation without forgetting does to the answer an agent gives.

Those four operations are my framing and not the post's. The post describes a
layered store and an offline pass that replays transcripts and distills them,
and it treats forgetting only as pruning to keep the top layer small. What a
stale fact does to the answer once it has been consolidated is left open, so
that is what this measures.

Zero dependencies for the simulation, deterministic, offline. The reader it
relies on is not assumed, it is measured against `claude-opus-5-5` and
`claude-haiku-5-5` over 240 calls.

## Finding

**Retrieval ranked the current value first in every run. Both models answered
the last line of the list instead.**

Thirty cases were built where the two disagree: the top-ranked memory holds the
current value, and a stale value appears lower down and more often. Each case was
shown four ways to each model.

| what the model saw | opus-5-5 right | haiku-5-5 right | answered the last line |
|---|---|---|---|
| plain list, best match first | **0.0%** | **0.0%** | 59/60 |
| same list, plus `(listed newest first)` | **100.0%** | **86.7%** | 1/60 |
| shuffled, no ordering cue | 20.0% | 20.0% | 60/60 |
| shuffled, each memory timestamped | **100.0%** | **96.7%** | 13/60 |

Retrieval hands back its best guess first, which puts its worst guess last, and
the bottom line is the one that gets answered. Not because the models weigh
repetition, and not because they override the ranking: a plain bulleted list
never says the order means anything, so there is no ranking for them to read.
Adding one line that says so moves opus from 0% to 100%.

## What that does to the simulation

Memories are written across 20 sessions. Some writes change a slot's value, the
rest re-affirm the value it already holds, because real agent memory records the
same fact over and over rather than only when something changes. Sweeping how
often a fact actually changes, averaged over 24 seeds:

| change rate | top-ranked | newest | **last** | copies: current / rival |
|---|---|---|---|---|
| 0.1 | 100% | 100% | **64.6%** | 4.90 / 1.61 |
| 0.3 | 100% | 100% | **24.0%** | 2.81 / 2.81 |
| 0.6 | 100% | 100% | **1.0%** | 1.54 / 2.42 |
| 0.9 | 100% | 100% | **0.0%** | 1.12 / 1.42 |
| 1.0 | 100% | 100% | **0.0%** | 1.00 / 1.00 |

Ranking breaks ties by recency, so the bottom of the top 5 is the oldest copy
still alive. The more often a slot changes, the more certainly that copy is
stale, so the curve falls the whole way to zero and stays there. By change rate
0.7 the agent gets essentially every answer wrong while top-1 retrieval is still
perfect.

None of this reaches a retrieval metric. Top-1 and newest sit at 100% across the
entire sweep, so an eval asking "did we retrieve the right memory" reports green
on every run in that table.

## Two fixes, both measured

1. **Forget.** A `supersede` policy retires the prior fact for a slot on write,
   and holds the `last` reader at 100% at every change rate, with 24 active
   memories instead of 128.
2. **Say what the order means.** One line of prompt gets opus to 100% and haiku
   to 86.7%. Per-memory timestamps get 100% and 96.7%, and survive shuffling.

Neither is a retrieval change, since retrieval was already right. The bug is in
how the context gets assembled and labelled.

## Method

- 12 slots (`subject.predicate` → value), 20 sessions, 4 writes per session
- Each write either changes the slot to its next value or re-affirms its current
  one, with `changeRate` controlling the split
- Retrieval is BM25-lite over active memories, `consolidate()` every 5 sessions
- Four readers turn the top 5 retrieved memories into one answer: `first` takes
  the top rank, `last` takes the bottom of the list, `newest` takes the highest
  timestamp, `majority` takes the most frequent value with ties broken by rank
- Answer accuracy is the share of slots where the reader returns the current value
- `src/validate.js` builds cases where `first` and `last` disagree, renders each
  four ways and asks both models. The verdict is the value in the reply, and the
  reply is one word because the system prompt asks for one

## Repro

```
npm run experiment    # four arms over 20 sessions
npm run sweep         # the change-rate curve above
npm test              # 16 assertions covering the harness itself
```

No install step, no API key, Node 18+.

The model run is the one thing that costs money. It needs `ANTHROPIC_API_KEY`
set in the environment, and it ran at $0.13 for all 240 calls:

```
npm run validate -- --dry    # print the four prompts and stop, no key, no spend
npm run validate:pilot       # 16 calls, prints the measured cost of the full run
npm run validate             # 30 cases x 4 renderings x 2 models
```

## Four things that were wrong first

All four made the result look better than it was, and all four are easy to repeat:

1. **The scorer tiebroke on recency by default.** Every fact for a slot has
   identical token length and identical query overlap, so they tie on BM25
   exactly and the tiebreak alone decides top-1. With recency baked in, every arm
   scored 100% and the experiment measured nothing.
2. **Sorting ties by memory id looked neutral and was not.** `'m10' < 'm9'`
   lexicographically, so it systematically returned the oldest fact, which is the
   worst case reported as though it were the average.
3. **The first headline number was arithmetic, not a result.** It reported that
   precision@5 fell to 20.0% while top-1 held at 100%. But once a slot holds five
   facts and exactly one is current, precision@5 is 1/5 by definition. Sweeping k
   confirmed it: p@k came out to exactly 1/k at every value of k. That is why this
   version measures what the reader concludes instead, and why re-affirmation had
   to be added, since without repeated writes there is nothing to get wrong.
4. **The second headline named the wrong mechanism, and a two-case pilot agreed
   with it.** The reader was `majority`, on the guess that a model weighs repeated
   context. It bottomed out at 40.3% at change rate 0.6, which supported a claim
   that intermediate churn is the worst case. A pilot of two cases came back
   consistent with it on both models. Both cases happened to put the repeated
   value on the last line, so repetition and position were indistinguishable at
   that sample size. Thirty cases separated them: answers matched the last line
   59 times out of 60, and matched the majority value only as often as the last
   line happened to be the majority value, 14 of 30. The real curve is monotonic,
   so there is no interesting middle. `majority` is still in `src/readers.js`
   because the contrast is the point.

The fixture had a fifth problem: slots ran out of values and began rewriting the
value they already held, accumulating correct duplicates and bending the curve
back upward. That one turned out to be worth keeping deliberately, which is what
re-affirmation now is.

## Limits

- **One prompt wording, two models, 30 cases.** The system prompt asks for a bare
  value, which discourages the model from reasoning out loud about ordering. A
  harness that asks it to explain itself might well do better, and that is the
  next thing worth running.
- **The unlabelled list is a deliberately careless assembly.** It is a common one,
  and the point is how much the label is worth, but 0% is a statement about that
  assembly rather than about either model.
- **`last` in the simulation takes the last candidate for the slot**, which
  matched the last rendered line in all 30 validation cases. Those cases held no
  digest lines, and in configurations that produce them the two could come apart.
- **Lexical retrieval, not embeddings.** Values are single tokens of equal length
  so BM25 ties exactly, which keeps the arms comparable but is not how real text
  behaves.
- **A fixed write budget.** 80 writes total, so a higher change rate mechanically
  means fewer repeats.
- **Synthetic sessions.** Every update is a clean overwrite of one slot, and real
  memory churn is messier and contradicts itself within a session.
- `supersede` assumes a well-formed `(subject, predicate)` key. Extracting that
  reliably from free text is most of the real problem and is skipped here.
