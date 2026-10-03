// consensus/timestampService.js
// 🛡️ v4.2 — Corrigido após auditoria (VULN-010, VULN-011)
const crypto = require('crypto');

class TimestampService {
  constructor({ maxEntries = 10_000, gcRatio = 0.1 } = {}) {
    this.timestamps = new Map();
    this.maxEntries = maxEntries;
    this.gcRatio = gcRatio;
    this.counter = 0;
  }

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

    // 🛡️ VULN-010: GC remove os mais antigos por timestamp, não por inserção
    if (this.timestamps.size > this.maxEntries) {
      this._gc();
    }

    return entry;
  }

  // 🛡️ VULN-010
  _gc() {
    const toRemove = Math.max(1, Math.floor(this.maxEntries * this.gcRatio));
    const entries = [...this.timestamps.entries()]
      .sort((a, b) => a[1].ts - b[1].ts);

    for (let i = 0; i < toRemove && i < entries.length; i++) {
      this.timestamps.delete(entries[i][0]);
    }
  }

  get(blockHash) {
    return this.timestamps.get(blockHash) || null;
  }

  // 🛡️ VULN-011: desempate determinístico e não manipulável
  resolveConflict(chainA, chainB) {
    const headA = chainA?.[chainA.length - 1];
    const headB = chainB?.[chainB.length - 1];
    if (!headA || !headB) return chainA;

    const entryA = this.timestamps.get(headA.hash);
    const entryB = this.timestamps.get(headB.hash);

    const tA = entryA?.order ?? Infinity;
    const tB = entryB?.order ?? Infinity;

    if (tA !== tB) {
      return tA < tB ? chainA : chainB;
    }

    // 🛡️ VULN-011: mesmo order → usa seq (criptograficamente aleatório)
    const seqA = entryA?.seq ?? '';
    const seqB = entryB?.seq ?? '';

    if (seqA !== seqB) {
      return seqA < seqB ? chainA : chainB;
    }

    // Último recurso: hash lexicográfico (determinístico)
    const hashA = headA.hash || '';
    const hashB = headB.hash || '';
    return hashA < hashB ? chainA : chainB;
  }

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
