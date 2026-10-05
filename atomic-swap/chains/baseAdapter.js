// atomic-swap/chains/baseAdapter.js
// ============================================
// Interface base para adapters de chain
// ============================================

class BaseAdapter {
    constructor(config = {}) {
        this.name = config.name || 'unknown';
        this.symbol = config.symbol || 'UNKNOWN';
        this.chainId = config.chainId || null;
        this.confirmations = config.confirmations || 6;
        this.blockTime = config.blockTime || 600;
        this.enabled = config.enabled !== false;
    }

    /**
     * Cria HTLC na chain externa
     * @returns {Promise<{htlcId, txHash, timelock, hashlock}>}
     */
    async lockHtlc({ sender, receiver, amount, hashlock, timelock, metadata }) {
        throw new Error(`${this.name}: lockHtlc não implementado`);
    }

    /**
     * Resgata HTLC com preimage
     */
    async claimHtlc({ htlcId, preimage, claimer }) {
        throw new Error(`${this.name}: claimHtlc não implementado`);
    }

    /**
     * Refunda HTLC após timelock
     */
    async refundHtlc({ htlcId, refunder }) {
        throw new Error(`${this.name}: refundHtlc não implementado`);
    }

    /**
     * Consulta status do HTLC
     */
    async getHtlcStatus(htlcId) {
        throw new Error(`${this.name}: getHtlcStatus não implementado`);
    }

    /**
     * Consulta saldo
     */
    async getBalance(address) {
        throw new Error(`${this.name}: getBalance não implementado`);
    }

    /**
     * Aguarda N confirmações
     */
    async waitForConfirmations(txHash, required = this.confirmations) {
        throw new Error(`${this.name}: waitForConfirmations não implementado`);
    }

    /**
     * Valida endereço
     */
    isValidAddress(address) {
        throw new Error(`${this.name}: isValidAddress não implementado`);
    }

    /**
     * Estima tempo de confirmação
     */
    estimateConfirmationTime() {
        return `${this.confirmations * this.blockTime}s`;
    }
}

module.exports = BaseAdapter;
