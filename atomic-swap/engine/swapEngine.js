// atomic-swap/engine/swapEngine.js
// ============================================
// SwapEngine — Orquestrador de atomic swaps
// ============================================
// Coordena o swap completo entre Bradicoin e chains externas.
//
// Fluxo BRD → BTC (Alice maker, Bob taker):
//   1. Alice cria SwapOrder (open)
//   2. Bob aceita (matched)
//   3. Alice gera secret S, H = sha256(S)
//   4. Alice trava BRD na Bradicoin (maker_locked)
//   5. Bob trava BTC no Bitcoin (taker_locked)
//   6. Alice revela S no HTLC BTC → pega BTC
//   7. Bob usa S no HTLC BRD → pega BRD (completed)
//
// Se algo falha:
//   - Após T_taker (menor), Bob refunda BTC
//   - Após T_maker (maior), Alice refunda BRD
// ============================================

const crypto = require('crypto');
const { EventEmitter } = require('events');

const SwapOrderModel = require('../../models/SwapOrder');
const SwapHistoryModel = require('../../models/SwapHistory');
const WalletModel = require('../../models/Wallet');

const htlc = require('./htlc');
const swapState = require('./swapState');

const wallet = require('../../wallet');

// ============================================
// CONFIG
// ============================================
const CONFIG = {
    // Quanto tempo o maker tem pra travar após match
    MAKER_LOCK_WINDOW_SECONDS: 30 * 60,    // 30 min

    // Quanto tempo o taker tem pra travar após maker
    TAKER_LOCK_WINDOW_SECONDS: 30 * 60,    // 30 min

    // Diferença entre timelock maker e taker
    // Taker SEMPRE tem timelock MENOR (pra não ficar preso)
    TIMELOCK_GAP_SECONDS: 6 * 60 * 60,     // 6h

    // Timelock default do taker
    DEFAULT_TAKER_TIMELOCK_SECONDS: 12 * 60 * 60,  // 12h

    // Janela pra maker cancelar antes de alguém aceitar
    ORDER_EXPIRY_SECONDS: 24 * 60 * 60,    // 24h

    // Fee do protocolo (0.1%)
    PROTOCOL_FEE_BPS: 10                    // 10 bps = 0.1%
};

// ============================================
// EVENTOS
// ============================================
class SwapEngine extends EventEmitter {
    constructor() {
        super();
        this.adapters = null;  // lazy-load pra evitar ciclo
        this._watchdogInterval = null;
    }

    _getAdapters() {
        if (!this.adapters) {
            this.adapters = require('../index');
        }
        return this.adapters;
    }

    _getAdapter(chain) {
        const { getAdapter } = this._getAdapters();
        return getAdapter(chain);
    }

    // ============================================
    // 1. CRIAR ORDEM (maker)
    // ============================================
    /**
     * Maker cria uma ordem de swap.
     *
     * @param {Object} opts
     * @param {string} opts.makerAddress
     * @param {string} opts.fromChain         - chain que o maker ENVIA
     * @param {string} opts.toChain           - chain que o maker QUER RECEBER
     * @param {string|number} opts.fromAmount - quanto o maker envia
     * @param {string|number} opts.toAmount   - quanto o maker quer receber
     * @param {string} opts.fromToken         - 'BRD', 'BTC', etc
     * @param {string} opts.toToken           - 'BRD', 'BTC', etc
     * @param {number} [opts.timelockMaker]   - unix ts (opcional)
     * @param {number} [opts.expiresInSeconds]
     */
    async createOrder({
        makerAddress,
        fromChain,
        toChain,
        fromAmount,
        toAmount,
        fromToken,
        toToken,
        timelockMaker = null,
        expiresInSeconds = CONFIG.ORDER_EXPIRY_SECONDS
    }) {
        // 1. Validações
        if (!makerAddress) throw new Error('makerAddress obrigatório');
        if (fromChain === toChain) throw new Error('fromChain e toChain devem ser diferentes');
        if (!fromToken || !toToken) throw new Error('fromToken e toToken obrigatórios');

        const fromAmt = parseFloat(fromAmount);
        const toAmt = parseFloat(toAmount);
        if (!Number.isFinite(fromAmt) || fromAmt <= 0) throw new Error('fromAmount inválido');
        if (!Number.isFinite(toAmt) || toAmt <= 0) throw new Error('toAmount inválido');

        // 2. Valida endereço no adapter da chain de origem
        const adapterFrom = this._getAdapter(fromChain);
        if (!adapterFrom.isValidAddress(makerAddress)) {
            throw new Error(`Endereço inválido pra chain ${fromChain}`);
        }

        // 3. Gera secret + hashlock
        const secret = this._generateSecret();
        const hashlock = this._hashSecret(secret);

        // 4. Calcula timelocks
        const now = Math.floor(Date.now() / 1000);
        const timelockMakerFinal = timelockMaker || (now + CONFIG.DEFAULT_TAKER_TIMELOCK_SECONDS + CONFIG.TIMELOCK_GAP_SECONDS);
        const timelockTakerFinal = timelockMakerFinal - CONFIG.TIMELOCK_GAP_SECONDS;

        // 5. Rate implícito
        const rate = (toAmt / fromAmt).toString();

        // 6. Cria no Mongo
        const swapId = this._generateSwapId();
        const expiresAt = new Date(Date.now() + expiresInSeconds * 1000);

        const order = await SwapOrderModel.create({
            swapId,
            maker: {
                address: makerAddress,
                chain: fromChain,
                amount: fromAmt.toString(),
                token: fromToken
            },
            taker: {
                address: null,
                chain: toChain,
                amount: toAmt.toString(),
                token: toToken
            },
            fromChain,
            toChain,
            fromToken,
            toToken,
            rate,
            hashlock,
            timelockMaker: timelockMakerFinal,
            timelockTaker: timelockTakerFinal,
            status: 'open',
            expiresAt,
            metadata: {
                secret: null,              // guardado criptografado depois
                secretPlain: secret,       // ⚠️ Em prod: criptografar com KMS
                makerLockWindow: CONFIG.MAKER_LOCK_WINDOW_SECONDS,
                takerLockWindow: CONFIG.TAKER_LOCK_WINDOW_SECONDS
            }
        });

        console.log(`📋 Ordem criada: ${swapId} | ${fromAmt} ${fromToken} → ${toAmt} ${toToken}`);

        this.emit('order:created', order.toPublic());

        return {
            order: order.toPublic(),
            // ⚠️ SEGREDO SÓ É RETORNADO UMA VEZ PRO MAKER
            // O maker precisa guardar isso pra revelar depois
            secret
        };
    }

    // ============================================
    // 2. ACEITAR ORDEM (taker)
    // ============================================
    async acceptOrder({ swapId, takerAddress }) {
        if (!swapId) throw new Error('swapId obrigatório');
        if (!takerAddress) throw new Error('takerAddress obrigatório');

        const order = await SwapOrderModel.findOne({ swapId });
        if (!order) throw new Error('Ordem não encontrada');
        if (order.status !== 'open') throw new Error(`Ordem não está open (status=${order.status})`);
        if (order.expiresAt < new Date()) throw new Error('Ordem expirada');

        // Valida endereço no adapter da chain de destino
        const adapterTo = this._getAdapter(order.toChain);
        if (!adapterTo.isValidAddress(takerAddress)) {
            throw new Error(`Endereço inválido pra chain ${order.toChain}`);
        }

        swapState.assertTransition(order.status, 'matched');

        order.taker.address = takerAddress;
        order.status = 'matched';
        await order.save();

        console.log(`🤝 Ordem aceita: ${swapId} por ${takerAddress}`);

        this.emit('order:matched', order.toPublic());

        return order.toPublic();
    }

    // ============================================
    // 3. MAKER TRAVA OS FUNDOS
    // ============================================
    async makerLock({ swapId, makerAddress }) {
        const order = await SwapOrderModel.findOne({ swapId });
        if (!order) throw new Error('Ordem não encontrada');

        const makerNorm = wallet.normalizeAddress(makerAddress);
        if (makerNorm !== order.maker.address) {
            throw new Error('Apenas o maker pode travar os fundos');
        }

        swapState.assertTransition(order.status, 'maker_locked');

        const adapter = this._getAdapter(order.fromChain);

        let htlcResult;
        try {
            htlcResult = await adapter.lockHtlc({
                sender: makerAddress,
                receiver: order.taker.address,
                amount: order.maker.amount.toString(),
                hashlock: order.hashlock,
                timelock: order.timelockMaker,
                swapId
            });
        } catch (e) {
            console.error(`❌ makerLock falhou: ${e.message}`);
            throw new Error(`Falha ao travar fundos do maker: ${e.message}`);
        }

        order.htlcMakerId = htlcResult.htlcId;
        order.status = 'maker_locked';
        await order.save();

        // Registra histórico
        await this._recordHistory(order, 'maker', 'maker_locked');

        console.log(`🔒 Maker travou fundos: ${swapId} | htlc=${htlcResult.htlcId}`);

        this.emit('order:maker_locked', order.toPublic());

        return {
            order: order.toPublic(),
            htlc: htlcResult
        };
    }

    // ============================================
    // 4. TAKER TRAVA OS FUNDOS
    // ============================================
    async takerLock({ swapId, takerAddress }) {
        const order = await SwapOrderModel.findOne({ swapId });
        if (!order) throw new Error('Ordem não encontrada');
        if (order.status !== 'maker_locked') {
            throw new Error(`Ordem não está maker_locked (status=${order.status})`);
        }

        const takerNorm = wallet.normalizeAddress(takerAddress);
        if (takerNorm !== order.taker.address) {
            throw new Error('Apenas o taker pode travar os fundos');
        }

        swapState.assertTransition(order.status, 'taker_locked');

        const adapter = this._getAdapter(order.toChain);

        let htlcResult;
        try {
            htlcResult = await adapter.lockHtlc({
                sender: takerAddress,
                receiver: order.maker.address,
                amount: order.taker.amount.toString(),
                hashlock: order.hashlock,       // mesmo hashlock!
                timelock: order.timelockTaker,  // MENOR que o do maker
                swapId
            });
        } catch (e) {
            console.error(`❌ takerLock falhou: ${e.message}`);
            throw new Error(`Falha ao travar fundos do taker: ${e.message}`);
        }

        order.htlcTakerId = htlcResult.htlcId;
        order.status = 'taker_locked';
        await order.save();

        await this._recordHistory(order, 'taker', 'taker_locked');

        console.log(`🔒 Taker travou fundos: ${swapId} | htlc=${htlcResult.htlcId}`);

        this.emit('order:taker_locked', order.toPublic());

        return {
            order: order.toPublic(),
            htlc: htlcResult
        };
    }

    // ============================================
    // 5. MAKER REVELA PREIMAGE (claim no HTLC taker)
    // ============================================
    async revealPreimage({ swapId, makerAddress, secret }) {
        const order = await SwapOrderModel.findOne({ swapId });
        if (!order) throw new Error('Ordem não encontrada');
        if (order.status !== 'taker_locked') {
            throw new Error(`Ordem não está taker_locked (status=${order.status})`);
        }

        const makerNorm = wallet.normalizeAddress(makerAddress);
        if (makerNorm !== order.maker.address) {
            throw new Error('Apenas o maker pode revelar o preimage');
        }

        // Confere que o secret bate com o hashlock
        const computed = this._hashSecret(secret);
        if (computed !== order.hashlock) {
            throw new Error('Secret não corresponde ao hashlock');
        }

        // Maker pega fundos travados pelo taker
        const adapterTaker = this._getAdapter(order.toChain);
        let claimResult;
        try {
            claimResult = await adapterTaker.claimHtlc({
                htlcId: order.htlcTakerId,
                preimage: secret,
                claimer: makerAddress
            });
        } catch (e) {
            console.error(`❌ revealPreimage falhou: ${e.message}`);
            throw new Error(`Falha ao reclamar fundos do taker: ${e.message}`);
        }

        order.preimage = secret;
        await order.save();

        console.log(`🔓 Preimage revelado: ${swapId}`);

        this.emit('order:preimage_revealed', {
            swapId,
            preimage: secret
        });

        return {
            order: order.toPublic(),
            claim: claimResult
        };
    }

    // ============================================
    // 6. TAKER RECLAMA (usa preimage revelado)
    // ============================================
    async takerClaim({ swapId, takerAddress }) {
        const order = await SwapOrderModel.findOne({ swapId });
        if (!order) throw new Error('Ordem não encontrada');
        if (order.status !== 'taker_locked') {
            throw new Error(`Ordem não está taker_locked (status=${order.status})`);
        }
        if (!order.preimage) {
            throw new Error('Preimage ainda não foi revelado pelo maker');
        }

        const takerNorm = wallet.normalizeAddress(takerAddress);
        if (takerNorm !== order.taker.address) {
            throw new Error('Apenas o taker pode reclamar');
        }

        // Taker pega fundos travados pelo maker
        const adapterMaker = this._getAdapter(order.fromChain);
        let claimResult;
        try {
            claimResult = await adapterMaker.claimHtlc({
                htlcId: order.htlcMakerId,
                preimage: order.preimage,
                claimer: takerAddress
            });
        } catch (e) {
            console.error(`❌ takerClaim falhou: ${e.message}`);
            throw new Error(`Falha ao reclamar fundos do maker: ${e.message}`);
        }

        swapState.assertTransition(order.status, 'completed');
        order.status = 'completed';
        order.completedAt = new Date();
        await order.save();

        await this._recordHistory(order, 'taker', 'completed');

        console.log(`✅ Swap COMPLETO: ${swapId}`);

        this.emit('order:completed', order.toPublic());

        return {
            order: order.toPublic(),
            claim: claimResult
        };
    }

    // ============================================
    // 7. REFUND (após timelock)
    // ============================================
    async refund({ swapId, caller }) {
        const order = await SwapOrderModel.findOne({ swapId });
        if (!order) throw new Error('Ordem não encontrada');
        if (swapState.isFinal(order.status)) {
            throw new Error(`Ordem já finalizada (${order.status})`);
        }

        const callerNorm = wallet.normalizeAddress(caller);
        const isMaker = callerNorm === order.maker.address;
        const isTaker = callerNorm === order.taker.address;

        if (!isMaker && !isTaker) {
            throw new Error('Apenas maker ou taker podem refundar');
        }

        const now = Math.floor(Date.now() / 1000);
        const results = [];

        // Maker tenta refundar o próprio HTLC (se passou o timelockMaker)
        if (isMaker && order.htlcMakerId && now >= order.timelockMaker) {
            const adapter = this._getAdapter(order.fromChain);
            try {
                const r = await adapter.refundHtlc({
                    htlcId: order.htlcMakerId,
                    refunder: caller
                });
                results.push({ side: 'maker', result: r });
            } catch (e) {
                console.error(`⚠️ Refund maker falhou: ${e.message}`);
            }
        }

        // Taker tenta refundar o próprio HTLC (se passou o timelockTaker)
        if (isTaker && order.htlcTakerId && now >= order.timelockTaker) {
            const adapter = this._getAdapter(order.toChain);
            try {
                const r = await adapter.refundHtlc({
                    htlcId: order.htlcTakerId,
                    refunder: caller
                });
                results.push({ side: 'taker', result: r });
            } catch (e) {
                console.error(`⚠️ Refund taker falhou: ${e.message}`);
            }
        }

        if (results.length === 0) {
            throw new Error('Nenhum timelock expirou ainda pra este caller');
        }

        order.status = 'refunded';
        order.refundedAt = new Date();
        await order.save();

        await this._recordHistory(order, isMaker ? 'maker' : 'taker', 'refunded');

        console.log(`↩️  Swap refundado: ${swapId}`);

        this.emit('order:refunded', order.toPublic());

        return {
            order: order.toPublic(),
            refunds: results
        };
    }

    // ============================================
    // 8. CANCELAR ORDEM (só se ainda não travou)
    // ============================================
    async cancelOrder({ swapId, makerAddress }) {
        const order = await SwapOrderModel.findOne({ swapId });
        if (!order) throw new Error('Ordem não encontrada');

        const makerNorm = wallet.normalizeAddress(makerAddress);
        if (makerNorm !== order.maker.address) {
            throw new Error('Apenas o maker pode cancelar');
        }

        if (!['open', 'matched'].includes(order.status)) {
            throw new Error(`Não pode cancelar ordem em status=${order.status}`);
        }

        swapState.assertTransition(order.status, 'cancelled');
        order.status = 'cancelled';
        await order.save();

        console.log(`🚫 Ordem cancelada: ${swapId}`);

        this.emit('order:cancelled', order.toPublic());

        return order.toPublic();
    }

    // ============================================
    // QUERIES
    // ============================================
    async getOrder(swapId) {
        const order = await SwapOrderModel.findOne({ swapId });
        if (!order) throw new Error('Ordem não encontrada');
        return order.toPublic();
    }

    async listOrders({ status, fromChain, toChain, address, limit = 50, offset = 0 } = {}) {
        const query = {};
        if (status) query.status = status;
        if (fromChain) query.fromChain = fromChain;
        if (toChain) query.toChain = toChain;
        if (address) {
            const norm = wallet.normalizeAddress(address);
            query.$or = [
                { 'maker.address': norm },
                { 'taker.address': norm }
            ];
        }

        limit = Math.min(Math.max(1, limit), 100);

        const [orders, total] = await Promise.all([
            SwapOrderModel.find(query).sort({ createdAt: -1 }).skip(offset).limit(limit),
            SwapOrderModel.countDocuments(query)
        ]);

        return {
            total,
            orders: orders.map(o => o.toPublic()),
            limit,
            offset,
            hasMore: offset + limit < total
        };
    }

    async getHistory(address, limit = 50, offset = 0) {
        const norm = wallet.normalizeAddress(address);
        const query = { address: norm };

        const [history, total] = await Promise.all([
            SwapHistoryModel.find(query).sort({ createdAt: -1 }).skip(offset).limit(limit),
            SwapHistoryModel.countDocuments(query)
        ]);

        return { total, history, limit, offset };
    }

    // ============================================
    // WATCHDOG — monitora timelocks expirados
    // ============================================
    startWatchdog(intervalMs = 60_000) {
        if (this._watchdogInterval) return;

        this._watchdogInterval = setInterval(async () => {
            try {
                await this._checkExpired();
            } catch (e) {
                console.error('❌ Watchdog error:', e.message);
            }
        }, intervalMs);

        console.log(`🐕 Watchdog iniciado (intervalo: ${intervalMs}ms)`);
    }

    stopWatchdog() {
        if (this._watchdogInterval) {
            clearInterval(this._watchdogInterval);
            this._watchdogInterval = null;
            console.log('🐕 Watchdog parado');
        }
    }

    async _checkExpired() {
        const now = Date.now();
        const active = await SwapOrderModel.find({
            status: { $in: ['matched', 'maker_locked', 'taker_locked'] }
        });

        for (const order of active) {
            const nowSec = Math.floor(now / 1000);

            // Se expirou a janela de lock do taker (maker_lock_window estourou)
            if (order.status === 'maker_locked' && order.updatedAt) {
                const elapsed = (now - order.updatedAt.getTime()) / 1000;
                if (elapsed > CONFIG.TAKER_LOCK_WINDOW_SECONDS) {
                    console.log(`⏰ Ordem ${order.swapId} expirou (taker não travou)`);
                    order.status = 'expired';
                    await order.save();
                    this.emit('order:expired', order.toPublic());
                }
            }

            // Se timelock do taker expirou sem claim
            if (order.status === 'taker_locked' && nowSec >= order.timelockTaker) {
                console.log(`⏰ Ordem ${order.swapId}: timelockTaker expirou`);
                this.emit('order:timelock_expired', {
                    swapId: order.swapId,
                    side: 'taker',
                    canRefund: 'taker'
                });
            }

            // Se timelock do maker expirou sem claim
            if (order.status === 'maker_locked' && nowSec >= order.timelockMaker) {
                console.log(`⏰ Ordem ${order.swapId}: timelockMaker expirou`);
                this.emit('order:timelock_expired', {
                    swapId: order.swapId,
                    side: 'maker',
                    canRefund: 'maker'
                });
            }
        }
    }

    // ============================================
    // HELPERS
    // ============================================
    _generateSwapId() {
        return 'SWAP_' + crypto.randomBytes(16).toString('hex');
    }

    _generateSecret() {
        return crypto.randomBytes(32).toString('hex');
    }

    _hashSecret(secret) {
        const { sha256 } = require('@noble/hashes/sha2');
        const { bytesToHex, utf8ToBytes } = require('@noble/hashes/utils');
        return bytesToHex(sha256(utf8ToBytes(secret)));
    }

    async _recordHistory(order, role, status) {
        try {
            await SwapHistoryModel.create({
                swapId: order.swapId,
                address: role === 'maker' ? order.maker.address : order.taker.address,
                role,
                fromChain: order.fromChain,
                toChain: order.toChain,
                fromAmount: order.maker.amount.toString(),
                toAmount: order.taker.amount?.toString() || order.maker.amount.toString(),
                fromToken: order.fromToken,
                toToken: order.toToken,
                status,
                completedAt: status === 'completed' ? new Date() : null
            });
        } catch (e) {
            console.error('Erro ao gravar histórico:', e.message);
        }
    }

    // ============================================
    // ESTATÍSTICAS
    // ============================================
    async getStats() {
        const [total, open, completed, refunded, expired] = await Promise.all([
            SwapOrderModel.countDocuments({}),
            SwapOrderModel.countDocuments({ status: 'open' }),
            SwapOrderModel.countDocuments({ status: 'completed' }),
            SwapOrderModel.countDocuments({ status: 'refunded' }),
            SwapOrderModel.countDocuments({ status: 'expired' })
        ]);

        return {
            total,
            open,
            completed,
            refunded,
            expired,
            successRate: total > 0 ? (completed / total * 100).toFixed(2) + '%' : '0%'
        };
    }
}

// Singleton
module.exports = new SwapEngine();
module.exports.CONFIG = CONFIG;
