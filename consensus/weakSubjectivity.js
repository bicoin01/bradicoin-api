// consensus/weakSubjectivity.js
// 🛡️ v4.2 — Corrigido após auditoria (VULN-008, VULN-009)
const crypto = require('crypto');

class WeakSubjectivity {
  constructor({
    periodBlocks = 1000,
    quorum = 0.67,
    maxCheckpointAgeBlocks = 2000,
    maxCheckpoints = 50,
    requireSignatureVerification = true,   // 🛡️ VULN-009
  } = {}) {
    this.periodBlocks = periodBlocks;
    this.quorum = quorum;
    this.maxCheckpointAgeBlocks = maxCheckpointAgeBlocks;
    this.maxCheckpoints = maxCheckpoints;
    this.requireSignatureVerification = requireSignatureVerification;
    this.checkpoints = [];
  }

  // 🛡️ VULN-008: valida checkpoint antes de aceitar
  addCheckpoint(cp, validatorSet = []) {
    if (!cp || typeof cp !== 'object') return false;
    if (typeof cp.height !== 'number' || cp.height < 0) return false;
    if (typeof cp.root !== 'string' || cp.root.length === 0) return false;
    if (!Array.isArray(cp.signatures)) return false;

    // 🛡️ VULN-008: valida quórum se temos validatorSet
    if (validatorSet.length > 0) {
      if (!this.verifyCheckpoint(cp, validatorSet)) {
        console.warn(`⚠️ Checkpoint ${cp.height} rejeitado: quórum insuficiente`);
        return false;
      }
    }

    this.checkpoints.push(cp);
    this.checkpoints.sort((a, b) => b.height - a.height);

    // Limita número de checkpoints
    if (this.checkpoints.length > this.maxCheckpoints) {
      this.checkpoints = this.checkpoints.slice(0, this.maxCheckpoints);
    }

    return true;
  }

  findTrustedCheckpoint(currentHeight) {
    const minHeight = Math.max(0, currentHeight - this.maxCheckpointAgeBlocks);
    return this.checkpoints.find((cp) => cp.height >= minHeight) || null;
  }

  // 🛡️ VULN-009: verificação criptográfica real (quando disponível)
  verifyCheckpoint(cp, validatorSet) {
    if (!cp || !Array.isArray(validatorSet) || validatorSet.length === 0) {
      return false;
    }

    const totalStake = validatorSet.reduce((s, v) => s + (v.stake || 0), 0);
    if (totalStake === 0) return false;

    let signedStake = 0;
    for (const sig of cp.signatures || []) {
      const v = validatorSet.find((x) => x.id === sig.validator);
      if (!v) continue;

      // 🛡️ VULN-009: verificação criptográfica
      let valid = false;
      if (this.requireSignatureVerification) {
        valid = this._verifySignature(cp.root, sig, v);
      } else {
        // Fallback: só aceita se explicitamente permitido
        valid = sig.valid === true && sig.signature !== undefined;
      }

      if (valid) signedStake += v.stake || 0;
    }

    return signedStake / totalStake >= this.quorum;
  }

  // 🛡️ VULN-009: verificação de assinatura com múltiplos algoritmos
  _verifySignature(message, sig, validator) {
    if (!sig.signature || !validator.publicKey) return false;

    try {
      // Suporta Ed25519 (padrão) ou ECDSA
      const algorithm = validator.signatureAlgorithm || 'ed25519';

      if (algorithm === 'ed25519') {
        const publicKey = crypto.createPublicKey({
          key: Buffer.from(validator.publicKey, 'hex'),
          format: 'der',
          type: 'spki',
        });
        return crypto.verify(
          null,
          Buffer.from(message, 'utf8'),
          publicKey,
          Buffer.from(sig.signature, 'hex')
        );
      }

      if (algorithm === 'ecdsa') {
        const publicKey = crypto.createPublicKey({
          key: Buffer.from(validator.publicKey, 'hex'),
          format: 'der',
          type: 'spki',
        });
        return crypto.verify(
          'sha256',
          Buffer.from(message, 'utf8'),
          publicKey,
          Buffer.from(sig.signature, 'hex')
        );
      }

      // Algoritmo desconhecido → rejeita
      return false;
    } catch (err) {
      // Erro de parsing → rejeita
      return false;
    }
  }

  validateChain(chain, validatorSet) {
    for (const cp of this.checkpoints) {
      const block = chain.find((b) => (b.height ?? b.index) === cp.height);
      if (!block) continue;

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
    return crypto.createHash('sha256')
      .update(JSON.stringify(block.state || block.stateRoot || {}))
      .digest('hex');
  }
}

module.exports = WeakSubjectivity;
