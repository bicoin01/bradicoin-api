// consensus/reorgDetector.js
// 🛡️ v4.2 — Corrigido após auditoria (VULN-003, VULN-004, VULN-005)
class ReorgDetector {
  constructor({
    maxDepth = 100,
    maxFrequent = 3,
    alertWindowMs = 300_000,
    cooldownMs = 60_000,
    maxHistory = 1000,
  } = {}) {
    this.maxDepth = maxDepth;
    this.maxFrequent = maxFrequent;
    this.alertWindowMs = alertWindowMs;
    this.cooldownMs = cooldownMs;
    this.maxHistory = maxHistory;
    this.history = [];
    this.lastAlert = 0;
  }

  _gc() {
    const cutoff = Date.now() - this.alertWindowMs;
    this.history = this.history.filter((h) => h.at >= cutoff);

    // 🛡️ VULN-004: limite duro no histórico
    if (this.history.length > this.maxHistory) {
      this.history = this.history.slice(-Math.floor(this.maxHistory / 2));
    }
  }

  check(newHead, oldHead) {
    if (!newHead || !oldHead) return { ok: true };

    // 🛡️ VULN-003: valida que height é número
    const newHeight = typeof newHead.height === 'number' ? newHead.height
                    : typeof newHead.index === 'number' ? newHead.index
                    : null;
    const oldHeight = typeof oldHead.height === 'number' ? oldHead.height
                    : typeof oldHead.index === 'number' ? oldHead.index
                    : null;

    // 🛡️ VULN-003: height ausente → reorg suspeito
    if (newHeight === null || oldHeight === null) {
      this._alert('invalid_height', { newHead, oldHead });
      return {
        ok: false,
        reason: 'invalid_height',
        action: 'halt_and_alert',
      };
    }

    const depth = oldHeight - newHeight;
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
    const recent = this.history.filter((h) => now - h.at < this.alertWindowMs);
    if (recent.length + 1 >= this.maxFrequent) {
      this._alert('frequent_reorgs', { count: recent.length + 1 });
      this.history.push({ at: now, depth, height: oldHeight });
      return {
        ok: false,
        reason: 'frequent_reorgs',
        count: recent.length + 1,
        action: 'throttle',
      };
    }

    this.history.push({ at: now, depth, height: oldHeight });
    return { ok: true, depth };
  }

  _alert(type, payload) {
    if (Date.now() - this.lastAlert < this.cooldownMs) return;
    this.lastAlert = Date.now();
    console.error(`🚨 [ReorgDetector] ${type}:`, payload);
  }

  // 🛡️ VULN-005: threshold dinâmico baseado em número de validadores
  isChainSuspicious(chain, validatorCount = 100) {
    if (!Array.isArray(chain) || chain.length === 0) return { ok: true };

    const tail = chain.slice(-200);
    const total = tail.length;
    if (total === 0) return { ok: true };

    // 🛡️ VULN-005: threshold adaptativo
    const threshold = validatorCount > 50 ? 0.30
                    : validatorCount > 10 ? 0.40
                    : 0.50;

    const counts = new Map();
    for (const b of tail) {
      const p = b?.miner || b?.producer || b?.validator;
      if (p) counts.set(p, (counts.get(p) || 0) + 1);
    }

    for (const [p, c] of counts) {
      if (c / total > threshold) {
        return {
          ok: false,
          reason: 'producer_dominance',
          producer: p,
          ratio: c / total,
          threshold,
        };
      }
    }

    return { ok: true };
  }
}

module.exports = ReorgDetector;
