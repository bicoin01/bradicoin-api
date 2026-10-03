// consensus/reorgDetector.js
class ReorgDetector {
  constructor({
    maxDepth = 100,
    maxFrequent = 3,
    alertWindowMs = 300_000,
    cooldownMs = 60_000,
  } = {}) {
    this.maxDepth = maxDepth;
    this.maxFrequent = maxFrequent;
    this.alertWindowMs = alertWindowMs;
    this.cooldownMs = cooldownMs;
    this.history = [];
    this.lastAlert = 0;
  }

  _gc() {
    const cutoff = Date.now() - this.alertWindowMs;
    this.history = this.history.filter(h => h.at >= cutoff);
  }

  check(newHead, oldHead) {
    if (!newHead || !oldHead) return { ok: true };

    const depth = (oldHead.height ?? 0) - (newHead.height ?? 0);
    if (depth <= 0) return { ok: true };

    const now = Date.now();
    this._gc();

    // Reorg muito profundo
    if (depth > this.maxDepth) {
      this._alert('deep_reorg', { depth, newHead, oldHead });
      return {
        ok: false,
        reason: 'deep_reorg',
        depth,
        action: 'halt_and_alert',
      };
    }

    // Reorgs frequentes
    const recent = this.history.filter(h => now - h.at < this.alertWindowMs);
    if (recent.length + 1 >= this.maxFrequent) {
      this._alert('frequent_reorgs', { count: recent.length + 1 });
      this.history.push({ at: now, depth, height: oldHead.height });
      return {
        ok: false,
        reason: 'frequent_reorgs',
        count: recent.length + 1,
        action: 'throttle',
      };
    }

    this.history.push({ at: now, depth, height: oldHead.height });
    return { ok: true, depth };
  }

  _alert(type, payload) {
    if (Date.now() - this.lastAlert < this.cooldownMs) return;
    this.lastAlert = Date.now();
    console.error(`🚨 [ReorgDetector] ${type}:`, payload);
    // aqui você pode: emitir evento, enviar webhook, pausar mineração
  }

  // Para nó que sincroniza do zero
  isChainSuspicious(chain) {
    // se um único produtor aparece > 40% dos blocos recentes, suspeito
    const tail = chain.slice(-200);
    const counts = new Map();
    for (const b of tail) {
      const p = b.miner || b.producer || b.validator;
      counts.set(p, (counts.get(p) || 0) + 1);
    }
    const total = tail.length;
    for (const [p, c] of counts) {
      if (c / total > 0.4) {
        return { ok: false, reason: 'producer_dominance', producer: p, ratio: c / total };
      }
    }
    return { ok: true };
  }
}

module.exports = ReorgDetector;
