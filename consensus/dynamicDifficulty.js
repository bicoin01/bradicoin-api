// consensus/dynamicDifficulty.js
class DynamicDifficulty {
  constructor({
    baseTarget,
    minTarget,
    maxTarget,
    alpha = 0.1,
    decayMs = 60_000,
  } = {}) {
    this.baseTarget = baseTarget;
    this.minTarget = minTarget;
    this.maxTarget = maxTarget;
    this.alpha = alpha;
    this.decayMs = decayMs;
    this.minerAttempts = new Map(); // miner -> { count, lastUpdate }
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

  // Target para o próximo bloco deste minerador
  getTarget(miner) {
    const attempts = this._decay(miner);
    const factor = Math.exp(-this.alpha * attempts);
    const target = Math.floor(this.baseTarget * factor);
    return Math.max(this.minTarget, Math.min(this.maxTarget, target));
  }

  // Registrar tentativa (chamar após cada bloco/tentativa)
  recordAttempt(miner) {
    const rec = this.minerAttempts.get(miner) || { count: 0, lastUpdate: Date.now() };
    rec.count += 1;
    rec.lastUpdate = Date.now();
    this.minerAttempts.set(miner, rec);
  }

  // Ajuste global de dificuldade baseado em tempo de bloco (opcional)
  adjustGlobal(blockTimes, targetTimeMs = 10_000) {
    if (blockTimes.length < 10) return this.baseTarget;
    const avg = blockTimes.reduce((a, b) => a + b, 0) / blockTimes.length;
    const ratio = avg / targetTimeMs;
    // se blocos estão rápidos demais, aumenta dificuldade (target menor)
    const newTarget = Math.floor(this.baseTarget * ratio);
    this.baseTarget = Math.max(this.minTarget, Math.min(this.maxTarget, newTarget));
    return this.baseTarget;
  }

  // Estatísticas
  stats() {
    const out = {};
    for (const [miner, rec] of this.minerAttempts) {
      out[miner] = { attempts: this._decay(miner) };
    }
    return out;
  }
}

module.exports = DynamicDifficulty;
