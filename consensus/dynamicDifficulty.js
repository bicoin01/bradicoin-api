// consensus/dynamicDifficulty.js
// 🛡️ v4.2 — Corrigido após auditoria (VULN-006, VULN-007)
class DynamicDifficulty {
  constructor({
    baseTarget,
    minTarget,
    maxTarget,
    alpha = 0.1,
    decayMs = 60_000,
    maxMiners = 1000,   // 🛡️ VULN-006
  } = {}) {
    this.baseTarget = baseTarget;
    this.minTarget = minTarget;
    this.maxTarget = maxTarget;
    this.alpha = alpha;
    this.decayMs = decayMs;
    this.maxMiners = maxMiners;
    this.minerAttempts = new Map();
  }

  // 🛡️ VULN-006: limita número de mineradores rastreados
  _enforceMaxMiners(miner) {
    if (this.minerAttempts.size < this.maxMiners) return;
    if (this.minerAttempts.has(miner)) return;

    // Remove o minerador com lastUpdate mais antigo
    let oldest = null;
    let oldestTime = Infinity;
    for (const [m, rec] of this.minerAttempts) {
      if (rec.lastUpdate < oldestTime) {
        oldestTime = rec.lastUpdate;
        oldest = m;
      }
    }
    if (oldest) this.minerAttempts.delete(oldest);
  }

  _decay(miner) {
    const rec = this.minerAttempts.get(miner);
    if (!rec) return 0;
    const dt = Date.now() - rec.lastUpdate;
    const factor = Math.pow(0.5, dt / this.decayMs);
    rec.count *= factor;
    rec.lastUpdate = Date.now();
    return rec.count;
  }

  getTarget(miner) {
    // 🛡️ VULN-006
    this._enforceMaxMiners(miner);

    const attempts = this._decay(miner);
    const factor = Math.exp(-this.alpha * attempts);
    const target = Math.floor(this.baseTarget * factor);
    return Math.max(this.minTarget, Math.min(this.maxTarget, target));
  }

  recordAttempt(miner) {
    // 🛡️ VULN-006
    this._enforceMaxMiners(miner);

    const rec = this.minerAttempts.get(miner)
      || { count: 0, lastUpdate: Date.now() };
    rec.count += 1;
    rec.lastUpdate = Date.now();
    this.minerAttempts.set(miner, rec);
  }

  adjustGlobal(blockTimes, targetTimeMs = 10_000) {
    if (!Array.isArray(blockTimes) || blockTimes.length < 10) {
      return this.baseTarget;
    }
    const avg = blockTimes.reduce((a, b) => a + b, 0) / blockTimes.length;
    const ratio = avg / targetTimeMs;
    const newTarget = Math.floor(this.baseTarget * ratio);
    this.baseTarget = Math.max(this.minTarget, Math.min(this.maxTarget, newTarget));
    return this.baseTarget;
  }

  // 🛡️ VULN-007: não muta o Map ao calcular stats
  stats() {
    const out = {};
    const now = Date.now();
    for (const [miner, rec] of this.minerAttempts) {
      const dt = now - rec.lastUpdate;
      const factor = Math.pow(0.5, dt / this.decayMs);
      out[miner] = {
        attempts: rec.count * factor,
        lastUpdate: rec.lastUpdate,
      };
    }
    return out;
  }
}

module.exports = DynamicDifficulty;
