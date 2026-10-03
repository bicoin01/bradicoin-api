// consensus/consecutiveBlockGuard.js
// 🛡️ v4.2 — Corrigido após auditoria (VULN-001, VULN-002)
class ConsecutiveBlockGuard {
  constructor({ maxConsecutive = 5 } = {}) {
    this.maxConsecutive = maxConsecutive;
  }

  // 🛡️ VULN-001: produtores undefined não quebram a lógica
  validate(chain) {
    if (!Array.isArray(chain) || chain.length === 0) {
      return { ok: true };
    }

    const getProducer = (b) => b?.miner || b?.producer || b?.validator || null;

    let count = 1;
    let currentProducer = getProducer(chain[0]);

    // 🛡️ VULN-001: se primeiro bloco não tem produtor, procura o próximo válido
    if (!currentProducer) {
      for (let i = 1; i < chain.length; i++) {
        const p = getProducer(chain[i]);
        if (p) {
          currentProducer = p;
          count = 1;
          break;
        }
      }
      // Se nenhum bloco tem produtor, não há o que validar
      if (!currentProducer) return { ok: true, reason: 'no_producer_info' };
    }

    for (let i = 1; i < chain.length; i++) {
      const producer = getProducer(chain[i]);

      // 🛡️ VULN-001: pula blocos sem produtor (não conta, não reseta)
      if (!producer) continue;

      if (producer === currentProducer) {
        count++;
        if (count > this.maxConsecutive) {
          return {
            ok: false,
            reason: 'consecutive_block_violation',
            producer,
            atHeight: chain[i].height ?? chain[i].index ?? null,
            streak: count,
          };
        }
      } else {
        currentProducer = producer;
        count = 1;
      }
    }

    return { ok: true };
  }

  // 🛡️ VULN-002: validateTail sempre analisa pelo menos maxConsecutive * 2 blocos
  validateTail(chain, tail = null) {
    if (!Array.isArray(chain) || chain.length === 0) return { ok: true };

    const minTail = (this.maxConsecutive || 5) * 2;
    const actualTail = Math.max(tail || minTail, minTail);
    const slice = chain.slice(-actualTail);

    return this.validate(slice);
  }

  // Usado no fork choice: candidato é válido?
  isCandidateValid(candidateChain) {
    return this.validateTail(candidateChain, 50).ok;
  }
}

module.exports = ConsecutiveBlockGuard;
