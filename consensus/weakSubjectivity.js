// consensus/weakSubjectivity.js
class WeakSubjectivity {
  constructor({
    periodBlocks = 1000,
    quorum = 0.67,
    maxCheckpointAgeBlocks = 2000,
  } = {}) {
    this.periodBlocks = periodBlocks;
    this.quorum = quorum;
    this.maxCheckpointAgeBlocks = maxCheckpointAgeBlocks;
    this.checkpoints = []; // { height, root, signatures: [{validator, valid}], ts }
  }

  addCheckpoint(cp) {
    this.checkpoints.push(cp);
    this.checkpoints.sort((a, b) => b.height - a.height);
    // mantém só os mais recentes
    if (this.checkpoints.length > 50) {
      this.checkpoints = this.checkpoints.slice(0, 50);
    }
  }

  // Nó novo encontra checkpoint recente para confiar
  findTrustedCheckpoint(currentHeight) {
    const minHeight = Math.max(0, currentHeight - this.maxCheckpointAgeBlocks);
    return this.checkpoints.find(cp => cp.height >= minHeight) || null;
  }

  // Verifica se o checkpoint tem quórum de stake
  verifyCheckpoint(cp, validatorSet) {
    if (!cp || !validatorSet?.length) return false;

    const totalStake = validatorSet.reduce((s, v) => s + (v.stake || 0), 0);
    if (totalStake === 0) return false;

    let signedStake = 0;
    for (const sig of cp.signatures || []) {
      if (!sig.valid) continue;
      const v = validatorSet.find(x => x.id === sig.validator);
      if (v) signedStake += v.stake || 0;
    }
    return signedStake / totalStake >= this.quorum;
  }

  // Verifica se uma cadeia conflita com checkpoints conhecidos
  validateChain(chain, validatorSet) {
    for (const cp of this.checkpoints) {
      const block = chain.find(b => b.height === cp.height);
      if (!block) continue; // checkpoint pode estar fora do range do chain
      const root = this._stateRoot(block);
      if (root !== cp.root) {
        return {
          ok: false,
          reason: 'checkpoint_conflict',
          height: cp.height,
          expected: cp.root,
          got: root,
        };
      }
      if (!this.verifyCheckpoint(cp, validatorSet)) {
        return {
          ok: false,
          reason: 'checkpoint_no_quorum',
          height: cp.height,
        };
      }
    }
    return { ok: true };
  }

  _stateRoot(block) {
    // mesma função usada ao criar o checkpoint
    const crypto = require('crypto');
    return crypto.createHash('sha256')
      .update(JSON.stringify(block.state || block.stateRoot || {}))
      .digest('hex');
  }
}

module.exports = WeakSubjectivity;
