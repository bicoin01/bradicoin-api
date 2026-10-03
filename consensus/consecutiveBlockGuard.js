// consensus/consecutiveBlockGuard.js
class ConsecutiveBlockGuard {
  constructor({ maxConsecutive = 5 } = {}) {
    this.maxConsecutive = maxConsecutive;
  }

  // Verifica uma cadeia inteira
  validate(chain) {
    if (!Array.isArray(chain) || chain.length === 0) {
      return { ok: true };
    }

    let count = 1;
    let currentProducer = chain[0].miner || chain[0].producer || chain[0].validator;

    for (let i = 1; i < chain.length; i++) {
      const producer = chain[i].miner || chain[i].producer || chain[i].validator;

      if (producer === currentProducer) {
        count++;
        if (count > this.maxConsecutive) {
          return {
            ok: false,
            reason: 'consecutive_block_violation',
            producer,
            atHeight: chain[i].height,
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

  // Verifica só os últimos N blocos (mais rápido para reorgs)
  validateTail(chain, tail = 20) {
    const slice = chain.slice(-tail);
    return this.validate(slice);
  }

  // Usado no fork choice: candidato é válido?
  isCandidateValid(candidateChain) {
    return this.validateTail(candidateChain, 50).ok;
  }
}

module.exports = ConsecutiveBlockGuard;
