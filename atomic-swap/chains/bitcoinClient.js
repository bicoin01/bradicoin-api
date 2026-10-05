// atomic-swap/chains/bitcoinClient.js
// ============================================
// Bitcoin Client — RPC via mempool.space API
// ============================================

const axios = require('axios');

class BitcoinClient {
    constructor({ apiUrl, network = 'testnet' }) {
        this.apiUrl = apiUrl || 'https://mempool.space/testnet/api';
        this.network = network;
        this.client = axios.create({
            baseURL: this.apiUrl,
            timeout: 30_000,
            headers: { 'User-Agent': 'Bradicoin-AtomicSwap/1.0' }
        });
    }

    // ============================================
    // UTXO
    // ============================================
    async getUtxos(address) {
        const { data } = await this.client.get(`/address/${address}/utxo`);
        return data.map(u => ({
            txid: u.txid,
            vout: u.vout,
            value: u.value,
            status: u.status
        }));
    }

    async getAddressInfo(address) {
        const { data } = await this.client.get(`/address/${address}`);
        return {
            address,
            chain_stats: data.chain_stats,
            mempool_stats: data.mempool_stats,
            balance: data.chain_stats.funded_txo_sum - data.chain_stats.spent_txo_sum
        };
    }

    // ============================================
    // TRANSAÇÕES
    // ============================================
    async getTx(txid) {
        const { data } = await this.client.get(`/tx/${txid}`);
        return {
            txid: data.txid,
            version: data.version,
            locktime: data.locktime,
            vin: data.vin,
            vout: data.vout,
            size: data.size,
            weight: data.weight,
            fee: data.fee,
            status: data.status,
            confirmations: data.status?.confirmed ? (data.status.block_height ? 1 : 0) : 0
        };
    }

    async getTxHex(txid) {
        const { data } = await this.client.get(`/tx/${txid}/hex`);
        return data;
    }

    async getTxStatus(txid) {
        const { data } = await this.client.get(`/tx/${txid}/status`);
        return {
            confirmed: data.confirmed,
            blockHeight: data.block_height,
            blockHash: data.block_hash,
            blockTime: data.block_time
        };
    }

    async broadcastTx(rawHex) {
        const { data } = await this.client.post('/tx', rawHex, {
            headers: { 'Content-Type': 'text/plain' }
        });
        return data;  // txid
    }

    // ============================================
    // FEE
    // ============================================
    async getFeeEstimates() {
        const { data } = await this.client.get('/v1/fees/recommended');
        return {
            fastestFee: data.fastestFee,
            halfHourFee: data.halfHourFee,
            hourFee: data.hourFee,
            economyFee: data.economyFee,
            minimumFee: data.minimumFee
        };
    }

    // ============================================
    // BLOCK
    // ============================================
    async getBlockHeight() {
        const { data } = await this.client.get('/blocks/tip/height');
        return data;
    }

    async getBlockHash(height) {
        const { data } = await this.client.get(`/block-height/${height}`);
        return data;
    }

    // ============================================
    // ESPERA CONFIRMAÇÕES
    // ============================================
    async waitForConfirmations(txid, required = 1, { pollInterval = 30_000, timeout = 60 * 60 * 1000 } = {}) {
        const start = Date.now();

        while (Date.now() - start < timeout) {
            try {
                const status = await this.getTxStatus(txid);

                if (status.confirmed && status.blockHeight) {
                    const tip = await this.getBlockHeight();
                    const confirmations = tip - status.blockHeight + 1;
                    if (confirmations >= required) {
                        return { confirmed: true, confirmations, blockHeight: status.blockHeight };
                    }
                }
            } catch (e) {
                console.warn(`⚠️  Aguardando confirmações de ${txid}: ${e.message}`);
            }

            await new Promise(r => setTimeout(r, pollInterval));
        }

        throw new Error(`Timeout aguardando confirmações de ${txid}`);
    }
}

module.exports = BitcoinClient;
