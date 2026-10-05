// bradicoin-sdk.js
// ============================================
// Bradicoin SDK — v2.0
// ============================================
// Cliente JavaScript pra interagir com a BradiChain
// via HTTP. Uso client-side ou server-side.
//
// Uso:
//   const Bradicoin = require('./bradicoin-sdk');
//   const sdk = new Bradicoin({ apiUrl: 'https://api.bradichain.com' });
//
//   // Wallet
//   const wallet = sdk.wallet.create();
//
//   // Atomic Swap
//   const secret = await sdk.atomicSwap.generateSecret();
//   const order = await sdk.atomicSwap.createOrder({ ... });
// ============================================

const crypto = require('crypto');

// ============================================
// ERROS
// ============================================
class BradicoinError extends Error {
    constructor(message, code, details) {
        super(message);
        this.name = 'BradicoinError';
        this.code = code || 'UNKNOWN';
        this.details = details || null;
    }
}

// ============================================
// HTTP CLIENT (fetch nativo ou fallback)
// ============================================
class HttpClient {
    constructor({ apiUrl, timeout = 30_000, headers = {} }) {
        if (!apiUrl) throw new Error('apiUrl obrigatório');
        this.apiUrl = apiUrl.replace(/\/$/, '');
        this.timeout = timeout;
        this.headers = {
            'Content-Type': 'application/json',
            'User-Agent': 'Bradicoin-SDK/2.0',
            ...headers
        };
        this.authToken = null;
    }

    setAuthToken(token) {
        this.authToken = token;
    }

    clearAuthToken() {
        this.authToken = null;
    }

    async request(method, path, { body = null, query = null, headers = {} } = {}) {
        let url = `${this.apiUrl}${path}`;

        if (query) {
            const qs = new URLSearchParams(
                Object.entries(query).filter(([, v]) => v !== undefined && v !== null)
            ).toString();
            if (qs) url += `?${qs}`;
        }

        const reqHeaders = { ...this.headers, ...headers };
        if (this.authToken) {
            reqHeaders['Authorization'] = `Bearer ${this.authToken}`;
        }

        const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
        const timer = controller ? setTimeout(() => controller.abort(), this.timeout) : null;

        try {
            const res = await fetch(url, {
                method,
                headers: reqHeaders,
                body: body ? JSON.stringify(body) : undefined,
                signal: controller?.signal
            });

            const text = await res.text();
            let data;
            try {
                data = text ? JSON.parse(text) : {};
            } catch (_) {
                data = { raw: text };
            }

            if (!res.ok) {
                throw new BradicoinError(
                    data.error || data.message || `HTTP ${res.status}`,
                    data.code || `HTTP_${res.status}`,
                    data
                );
            }

            return data;
        } catch (e) {
            if (e.name === 'AbortError') {
                throw new BradicoinError('Timeout na requisição', 'TIMEOUT');
            }
            if (e instanceof BradicoinError) throw e;
            throw new BradicoinError(e.message, 'NETWORK_ERROR');
        } finally {
            if (timer) clearTimeout(timer);
        }
    }

    get(path, opts)    { return this.request('GET', path, opts); }
    post(path, opts)   { return this.request('POST', path, opts); }
    put(path, opts)    { return this.request('PUT', path, opts); }
    del(path, opts)    { return this.request('DELETE', path, opts); }
}

// ============================================
// WALLET
// ============================================
class WalletClient {
    constructor(http) {
        this.http = http;
    }

    async getBalance(address) {
        const { data } = await this.http.get(`/api/v1/wallet/${address}/balance`);
        return data;
    }

    async getInfo(address) {
        const { data } = await this.http.get(`/api/v1/wallet/${address}`);
        return data;
    }

    async getHistory(address, { limit = 50, offset = 0 } = {}) {
        const { data } = await this.http.get(`/api/v1/wallet/${address}/history`, {
            query: { limit, offset }
        });
        return data;
    }

    async getStats() {
        const { data } = await this.http.get('/api/v1/wallet/stats');
        return data;
    }

    /**
     * Gera uma wallet local (não registra no servidor)
     */
    create() {
        const secp256k1 = require('@noble/secp256k1');
        const { keccak_256 } = require('@noble/hashes/sha3');
        const { bytesToHex, utf8ToBytes } = require('@noble/hashes/utils');
        const { sha256 } = require('@noble/hashes/sha2');

        // Gera par de chaves
        const privateKey = bytesToHex(secp256k1.utils.randomPrivateKey());
        const publicKey = bytesToHex(secp256k1.getPublicKey(privateKey, true));

        // Deriva endereço Br...
        const pubKeyBytes = Buffer.from(publicKey, 'hex');
        const hash = keccak_256(pubKeyBytes);
        const addressBytes = hash.slice(-19);
        const address = 'Br' + bytesToHex(addressBytes).toLowerCase();

        return {
            address,
            publicKey,
            privateKey,
            warning: 'GUARDE A PRIVATE KEY! Ela nunca sai do seu dispositivo.'
        };
    }

    /**
     * Assina uma mensagem
     */
    sign(message, privateKey) {
        const secp256k1 = require('@noble/secp256k1');
        const { sha256 } = require('@noble/hashes/sha2');
        const { utf8ToBytes } = require('@noble/hashes/utils');

        const msgBytes = typeof message === 'string' ? utf8ToBytes(message) : message;
        const hash = sha256(msgBytes);

        const pk = privateKey.startsWith('0x') ? privateKey.slice(2) : privateKey;
        const sig = secp256k1.sign(hash, pk);

        return sig.toCompactHex ? sig.toCompactHex() : Buffer.from(sig).toString('hex');
    }

    /**
     * Verifica assinatura
     */
    verify(message, signature, publicKey) {
        try {
            const secp256k1 = require('@noble/secp256k1');
            const { sha256 } = require('@noble/hashes/sha2');
            const { utf8ToBytes, hexToBytes } = require('@noble/hashes/utils');

            const msgBytes = typeof message === 'string' ? utf8ToBytes(message) : message;
            const hash = sha256(msgBytes);

            return secp256k1.verify(hexToBytes(signature), hash, publicKey);
        } catch (_) {
            return false;
        }
    }
}

// ============================================
// TRANSACTIONS
// ============================================
class TransactionClient {
    constructor(http) {
        this.http = http;
    }

    async get(txHash) {
        const { data } = await this.http.get(`/api/v1/transaction/${txHash}`);
        return data;
    }

    async submit(signedTx) {
        return this.http.post('/api/v1/transaction/submit', { body: signedTx });
    }

    async getStats() {
        const { data } = await this.http.get('/api/v1/transaction/stats');
        return data;
    }
}

// ============================================
// ATOMIC SWAP — 🌟 MÓDULO PRINCIPAL
// ============================================
class AtomicSwapClient {
    constructor(http) {
        this.http = http;
        this.basePath = '/api/atomic-swap';
    }

    // ============================================
    // INFO / CONFIG
    // ============================================
    async listChains() {
        const { chains } = await this.http.get(`${this.basePath}/chains`);
        return chains;
    }

    async getConfig() {
        const { config } = await this.http.get(`${this.basePath}/config`);
        return config;
    }

    async getStats() {
        const { stats } = await this.http.get(`${this.basePath}/stats`);
        return stats;
    }

    // ============================================
    // SECRET — Geração e validação
    // ============================================
    /**
     * Gera um secret + hashlock (client-side)
     */
    generateSecret() {
        const secret = crypto.randomBytes(32).toString('hex');
        const { sha256 } = require('@noble/hashes/sha2');
        const { bytesToHex, utf8ToBytes } = require('@noble/hashes/utils');
        const hashlock = bytesToHex(sha256(utf8ToBytes(secret)));
        return { secret, hashlock };
    }

    /**
     * Gera hashlock a partir de um secret existente
     */
    hashSecret(secret) {
        const { sha256 } = require('@noble/hashes/sha2');
        const { bytesToHex, utf8ToBytes } = require('@noble/hashes/utils');
        return bytesToHex(sha256(utf8ToBytes(secret)));
    }

    /**
     * Verifica secret localmente
     */
    verifySecret(secret, hashlock) {
        try {
            return this.hashSecret(secret).toLowerCase() === hashlock.toLowerCase();
        } catch (_) {
            return false;
        }
    }

    /**
     * Gera secret via servidor (server-side, mais seguro)
     */
    async generateSecretRemote() {
        return this.http.post(`${this.basePath}/secret/generate`);
    }

    // ============================================
    // HTLC — Nativo Bradicoin
    // ============================================
    async lockHtlc({ sender, receiver, amount, hashlock, timelock, swapId }) {
        return this.http.post(`${this.basePath}/htlc/lock`, {
            body: { sender, receiver, amount, hashlock, timelock, swapId }
        });
    }

    async claimHtlc({ htlcId, preimage, claimer }) {
        return this.http.post(`${this.basePath}/htlc/claim`, {
            body: { htlcId, preimage, claimer }
        });
    }

    async refundHtlc({ htlcId, refunder }) {
        return this.http.post(`${this.basePath}/htlc/refund`, {
            body: { htlcId, refunder }
        });
    }

    async getHtlc(htlcId) {
        const { htlc } = await this.http.get(`${this.basePath}/htlc/${htlcId}`);
        return htlc;
    }

    async listHtlcs({ address, status, chain, limit = 50, offset = 0 } = {}) {
        return this.http.get(`${this.basePath}/htlc`, {
            query: { address, status, chain, limit, offset }
        });
    }

    // ============================================
    // SWAP ENGINE — Orquestração cross-chain
    // ============================================
    /**
     * Cria ordem de swap.
     * ⚠️ Guarde o `secret` retornado — ele só aparece UMA vez.
     */
    async createOrder({
        makerAddress,
        fromChain,
        toChain,
        fromAmount,
        toAmount,
        fromToken,
        toToken,
        timelockMaker,
        expiresInSeconds
    }) {
        const res = await this.http.post(`${this.basePath}/order`, {
            body: {
                makerAddress,
                fromChain,
                toChain,
                fromAmount,
                toAmount,
                fromToken,
                toToken,
                timelockMaker,
                expiresInSeconds
            }
        });
        return res;
    }

    async acceptOrder({ swapId, takerAddress }) {
        const { order } = await this.http.post(`${this.basePath}/order/accept`, {
            body: { swapId, takerAddress }
        });
        return order;
    }

    async makerLock({ swapId, makerAddress }) {
        return this.http.post(`${this.basePath}/order/maker-lock`, {
            body: { swapId, makerAddress }
        });
    }

    async takerLock({ swapId, takerAddress }) {
        return this.http.post(`${this.basePath}/order/taker-lock`, {
            body: { swapId, takerAddress }
        });
    }

    async revealPreimage({ swapId, makerAddress, secret }) {
        return this.http.post(`${this.basePath}/order/reveal`, {
            body: { swapId, makerAddress, secret }
        });
    }

    async takerClaim({ swapId, takerAddress }) {
        return this.http.post(`${this.basePath}/order/taker-claim`, {
            body: { swapId, takerAddress }
        });
    }

    async refundOrder({ swapId, caller }) {
        return this.http.post(`${this.basePath}/order/refund`, {
            body: { swapId, caller }
        });
    }

    async cancelOrder({ swapId, makerAddress }) {
        const { order } = await this.http.post(`${this.basePath}/order/cancel`, {
            body: { swapId, makerAddress }
        });
        return order;
    }

    async getOrder(swapId) {
        const { order } = await this.http.get(`${this.basePath}/order/${swapId}`);
        return order;
    }

    async listOrders({ status, fromChain, toChain, address, limit = 50, offset = 0 } = {}) {
        return this.http.get(`${this.basePath}/order`, {
            query: { status, fromChain, toChain, address, limit, offset }
        });
    }

    async getHistory({ address, limit = 50, offset = 0 }) {
        return this.http.get(`${this.basePath}/history`, {
            query: { address, limit, offset }
        });
    }

    // ============================================
    // ORDER BOOK P2P
    // ============================================
    async getOrderBookPairs() {
        const { pairs } = await this.http.get(`${this.basePath}/orderbook/pairs`);
        return pairs;
    }

    async getOrderBookStats() {
        const { stats } = await this.http.get(`${this.basePath}/orderbook/stats`);
        return stats;
    }

    async listOrderBookOrders() {
        const { orders } = await this.http.get(`${this.basePath}/orderbook/orders`);
        return orders;
    }

    async searchOrderBook({ fromChain, fromToken, toChain, toToken, maxResults = 20 }) {
        const { orders } = await this.http.post(`${this.basePath}/orderbook/search`, {
            body: { fromChain, fromToken, toChain, toToken, maxResults }
        });
        return orders;
    }

    // ============================================
    // GOSSIP
    // ============================================
    async getGossipStats() {
        const { stats } = await this.http.get(`${this.basePath}/gossip/stats`);
        return stats;
    }

    // ============================================
    // MATCHER
    // ============================================
    async findMatches({ fromChain, fromToken, toChain, toToken, amountIn, maxResults = 10 }) {
        const { matches } = await this.http.post(`${this.basePath}/match/find`, {
            body: { fromChain, fromToken, toChain, toToken, amountIn, maxResults }
        });
        return matches;
    }

    async getTopPairs(limit = 20) {
        const { pairs } = await this.http.post(`${this.basePath}/match/top-pairs`, {
            body: { limit }
        });
        return pairs;
    }

    // ============================================
    // PUBLISH — Cria + anuncia via gossip
    // ============================================
    async publishOrder(opts) {
        return this.http.post(`${this.basePath}/order/publish`, { body: opts });
    }

    // ============================================
    // 🚀 HIGH-LEVEL — Fluxo completo
    // ============================================
    /**
     * Fluxo completo do MAKER:
     *   1. Cria ordem
     *   2. Aguarda taker aceitar (polling)
     *   3. Trava fundos
     *   4. Aguarda taker travar
     *   5. Revela preimage
     *
     * @param {Object} opts
     * @param {Function} [opts.onProgress] - callback(state) chamado a cada etapa
     * @returns {Promise<Object>} - resultado final
     */
    async runMakerFlow({
        makerAddress,
        fromChain,
        toChain,
        fromAmount,
        toAmount,
        fromToken,
        toToken,
        pollIntervalMs = 10_000,
        timeoutMs = 60 * 60 * 1000,
        onProgress = () => {}
    }) {
        const start = Date.now();
        const log = (step, data) => onProgress({ step, data, elapsed: Date.now() - start });

        // 1. Cria ordem
        log('creating_order');
        const created = await this.createOrder({
            makerAddress, fromChain, toChain,
            fromAmount, toAmount, fromToken, toToken
        });
        const { order, secret } = created;
        log('order_created', { swapId: order.swapId });

        // 2. Aguarda taker
        log('waiting_taker');
        let currentOrder;
        while (Date.now() - start < timeoutMs) {
            currentOrder = await this.getOrder(order.swapId);
            if (currentOrder.status === 'matched') break;
            if (currentOrder.status === 'cancelled' || currentOrder.status === 'expired') {
                throw new BradicoinError(`Ordem ${currentOrder.status}`, 'ORDER_CLOSED');
            }
            await new Promise(r => setTimeout(r, pollIntervalMs));
        }
        log('taker_matched', { taker: currentOrder.taker.address });

        // 3. Maker trava fundos
        log('locking_funds');
        const lockResult = await this.makerLock({ swapId: order.swapId, makerAddress });
        log('funds_locked', lockResult);

        // 4. Aguarda taker travar
        log('waiting_taker_lock');
        while (Date.now() - start < timeoutMs) {
            currentOrder = await this.getOrder(order.swapId);
            if (currentOrder.status === 'taker_locked') break;
            if (currentOrder.status === 'refunded') {
                throw new BradicoinError('Taker não travou a tempo', 'TAKER_TIMEOUT');
            }
            await new Promise(r => setTimeout(r, pollIntervalMs));
        }
        log('taker_locked');

        // 5. Revela preimage
        log('revealing_preimage');
        const revealResult = await this.revealPreimage({
            swapId: order.swapId,
            makerAddress,
            secret
        });
        log('preimage_revealed', revealResult);

        // 6. Aguarda taker pegar
        log('waiting_completion');
        while (Date.now() - start < timeoutMs) {
            currentOrder = await this.getOrder(order.swapId);
            if (currentOrder.status === 'completed') break;
            await new Promise(r => setTimeout(r, pollIntervalMs));
        }
        log('completed');

        return {
            swapId: order.swapId,
            status: 'completed',
            finalOrder: currentOrder
        };
    }

    /**
     * Fluxo completo do TAKER:
     *   1. Busca ordens
     *   2. Aceita a melhor
     *   3. Aguarda maker travar
     *   4. Trava fundos
     *   5. Aguarda preimage
     *   6. Reclama
     */
    async runTakerFlow({
        takerAddress,
        fromChain,
        fromToken,
        toChain,
        toToken,
        amountIn,
        minRate = null,
        pollIntervalMs = 10_000,
        timeoutMs = 60 * 60 * 1000,
        onProgress = () => {}
    }) {
        const start = Date.now();
        const log = (step, data) => onProgress({ step, data, elapsed: Date.now() - start });

        // 1. Busca matches
        log('searching_orders');
        const matches = await this.findMatches({
            fromChain, fromToken, toChain, toToken,
            amountIn, maxResults: 5
        });

        if (matches.length === 0) {
            throw new BradicoinError('Nenhuma ordem compatível encontrada', 'NO_MATCHES');
        }

        // Filtra por minRate
        let best = matches[0];
        if (minRate) {
            best = matches.find(m => m.effectiveRate >= minRate);
            if (!best) throw new BradicoinError(`Nenhuma ordem com rate >= ${minRate}`, 'NO_MATCHES');
        }

        log('match_found', { swapId: best.swapId, rate: best.effectiveRate });

        // 2. Aceita
        log('accepting_order');
        await this.acceptOrder({ swapId: best.swapId, takerAddress });
        log('order_accepted');

        // 3. Aguarda maker travar
        log('waiting_maker_lock');
        let currentOrder;
        while (Date.now() - start < timeoutMs) {
            currentOrder = await this.getOrder(best.swapId);
            if (currentOrder.status === 'maker_locked') break;
            if (currentOrder.status === 'cancelled' || currentOrder.status === 'refunded') {
                throw new BradicoinError('Maker não travou', 'MAKER_TIMEOUT');
            }
            await new Promise(r => setTimeout(r, pollIntervalMs));
        }
        log('maker_locked');

        // 4. Taker trava
        log('locking_funds');
        await this.takerLock({ swapId: best.swapId, takerAddress });
        log('funds_locked');

        // 5. Aguarda preimage ser revelado
        log('waiting_preimage');
        while (Date.now() - start < timeoutMs) {
            currentOrder = await this.getOrder(best.swapId);
            if (currentOrder.preimage) break;
            await new Promise(r => setTimeout(r, pollIntervalMs));
        }
        log('preimage_revealed');

        // 6. Taker reclamа
        log('claiming');
        const claimResult = await this.takerClaim({ swapId: best.swapId, takerAddress });
        log('completed');

        return {
            swapId: best.swapId,
            status: 'completed',
            claim: claimResult
        };
    }

    /**
     * Monitora uma ordem até finalizar (polling)
     */
    async watchOrder(swapId, { pollIntervalMs = 10_000, timeoutMs = 24 * 60 * 60 * 1000, onUpdate = () => {} } = {}) {
        const start = Date.now();
        let last = null;

        while (Date.now() - start < timeoutMs) {
            const order = await this.getOrder(swapId);
            if (JSON.stringify(order) !== JSON.stringify(last)) {
                onUpdate(order);
                last = order;
            }

            if (['completed', 'refunded', 'cancelled', 'expired'].includes(order.status)) {
                return order;
            }

            await new Promise(r => setTimeout(r, pollIntervalMs));
        }

        throw new BradicoinError('Timeout monitorando ordem', 'WATCH_TIMEOUT');
    }
}

// ============================================
// CLIENTE PRINCIPAL
// ============================================
class Bradicoin {
    constructor({ apiUrl, timeout = 30_000, headers = {}, authToken = null } = {}) {
        this.http = new HttpClient({ apiUrl, timeout, headers });
        if (authToken) this.http.setAuthToken(authToken);

        // Sub-clientes
        this.wallet = new WalletClient(this.http);
        this.transactions = new TransactionClient(this.http);
        this.atomicSwap = new AtomicSwapClient(this.http);
    }

    setAuthToken(token) {
        this.http.setAuthToken(token);
    }

    clearAuthToken() {
        this.http.clearAuthToken();
    }

    // ============================================
    // HEALTH
    // ============================================
    async health() {
        return this.http.get('/health');
    }

    async healthDetailed() {
        return this.http.get('/health/detailed');
    }

    async version() {
        return this.http.get('/api/version').catch(() => ({ version: 'unknown' }));
    }

    // ============================================
    // STATS
    // ============================================
    async networkStats() {
        const { data } = await this.http.get('/api/explorer/stats');
        return data;
    }

    async recentTransactions(limit = 20) {
        const { data } = await this.http.get('/api/explorer/transactions', { query: { limit } });
        return data;
    }

    async listValidators() {
        const { data } = await this.http.get('/api/validator/list');
        return data;
    }
}

// ============================================
// EXPORTS
// ============================================
module.exports = Bradicoin;
module.exports.Bradicoin = Bradicoin;
module.exports.BradicoinError = BradicoinError;
module.exports.HttpClient = HttpClient;
module.exports.AtomicSwapClient = AtomicSwapClient;
module.exports.WalletClient = WalletClient;
module.exports.TransactionClient = TransactionClient;
