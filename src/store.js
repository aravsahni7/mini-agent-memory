import { rank } from './scorer.js';

// A memory store with the four operations the post describes, which are write,
// recall, consolidate and forget
// The only thing that changes between arms is the forgetting policy, so that
// everything else is held constant. 'none' never evicts anything, which is the
// arm under test, and 'supersede' retires the old fact whenever the same
// subject and predicate is written again.
// The tiebreak is kept separate, since ranking by recency is a weak stand-in for
// forgetting rather than a forgetting policy of its own
export class MemoryStore {
  constructor({ forgetPolicy = 'none', tiebreak = 'random', tieSeed = 1 } = {}) {
    this.forgetPolicy = forgetPolicy;
    this.tiebreak = tiebreak;
    this.tieSeed = tieSeed;
    this.memories = [];
    this.clock = 0;
    this.stats = { writes: 0, evicted: 0, consolidations: 0 };
  }

  write({ subject, predicate, value, sessionId }) {
    const t = ++this.clock;
    const memory = {
      id: `m${t}`,
      kind: 'fact',
      subject,
      predicate,
      value,
      sessionId,
      t,
      active: true,
      text: `${subject} ${predicate} ${value}`,
    };
    this.memories.push(memory);
    this.stats.writes++;

    if (this.forgetPolicy === 'supersede') {
      this.forget({ subject, predicate, exceptId: memory.id });
    }
    return memory;
  }

  // Retire the memories for one slot, and any digest covering that subject along
  // with them, since a digest built from retired facts is stale too
  forget({ subject, predicate, exceptId = null }) {
    for (const m of this.memories) {
      if (!m.active) continue;
      if (m.id === exceptId) continue;
      if (m.subject !== subject) continue;
      if (m.kind === 'fact' && m.predicate !== predicate) continue;
      m.active = false;
      m.retiredAt = this.clock;
      this.stats.evicted++;
    }
  }

  // Collapse the facts for each subject into a single digest memory
  // The digest is built from whatever is active when it runs, so under 'none' it
  // picks up superseded values as well and ends up listing every value the slot
  // has ever held, with nothing to tell them apart. That ambiguity is the thing
  // being measured.
  consolidate() {
    this.stats.consolidations++;
    const t = ++this.clock;
    const bySubject = new Map();

    for (const m of this.memories) {
      if (!m.active || m.kind !== 'fact') continue;
      if (!bySubject.has(m.subject)) bySubject.set(m.subject, []);
      bySubject.get(m.subject).push(m);
    }

    for (const [subject, facts] of bySubject) {
      const parts = facts.map((f) => `${f.predicate} ${f.value}`);
      this.memories.push({
        id: `d${t}-${subject}`,
        kind: 'digest',
        subject,
        predicate: null,
        value: null,
        covers: facts.map((f) => f.id),
        t,
        active: true,
        text: `${subject} ${parts.join(' and ')}`,
      });
    }
  }

  recall(query, k = 5) {
    const active = this.memories.filter((m) => m.active);
    return rank(query, active, { tiebreak: this.tiebreak, tieSeed: this.tieSeed })
      .slice(0, k)
      .map((s) => ({ ...s.doc, score: s.score }));
  }

  size() {
    return this.memories.filter((m) => m.active).length;
  }
}
