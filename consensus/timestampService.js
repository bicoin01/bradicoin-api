// consensus/timestampService.js
const crypto = require('crypto');

class TimestampService {
  constructor({ maxEntries = 10_000 } = {}) {
    this.timestamps = new Map(); // blockHash -> { ts, seq, order }
    this.maxEntries = maxEntries;
    this.counter = 0;
  }

  // Chamar quando um bloco é visto pela primeira vez
  stamp(block) {
    if (!block?.hash) return null;
    if (this.timestamps.has(block.hash)) {
      return this.timestamps.get(block.hash);
    }

    const entry = {
      ts: Date.now(),
      seq: crypto.randomBytes(32).toString('hex'),
      order: ++this.counter,
    };
    this.timestamps.set(block.hash, entry);

    // GC
    if (this.timestamps.size > this.maxEntries) {
      const firstKey = this.timestamps.keys().next().value;
      this.timestamps.delete(firstKey);
    }

    return entry;
  }

  get(blockHash) {
    return this.timestamps.get(blockHash) || null;
  }

  // Em conflito entre duas cadeias válidas:
  resolveConflict(chainA, chainB) {
    const headA = chainA.at(-1);
    const headB = chainB.at(-1);
    const tA = this.timestamps.get(headA?.hash)?.order ?? Infinity;
    const tB = this.timestamps.get(headB?.hash)?.order ?? Infinity;
    if (tA === tB) {
      // desempate: maior altura, depois hash lexicográfico
      if (headA.height !== headB.height) {
        return headA.height > headB.height ? chainA : chainB;
      }
      return headA.hash < headB.hash ? chainA : chainB;
    }
    return tA < tB ? chainA : chainB;
  }

  // Prova de que o bloco foi visto em determinado momento
  proof(blockHash) {
    const e = this.timestamps.get(blockHash);
    if (!e) return null;
    return {
      blockHash,
      ts: e.ts,
      seq: e.seq,
      order: e.order,
    };
  }
}

module.exports = TimestampService;
