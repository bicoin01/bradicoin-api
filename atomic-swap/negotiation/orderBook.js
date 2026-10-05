// atomic-swap/negotiation/orderBook.js
// ============================================
// OrderBook — Livro de ordens local (por peer)
// ============================================
// Mantém ordens recebidas via gossip em memória + Mongo.
// Indexa por par (fromChain→toChain) pra busca rápida.
// ============================================

const { EventEmitter } = require('events');
const SwapOrderModel = require('../../models/SwapOrder');

const ORDER_TTL_MS = 24 * 60 * 60 * 1000;   // 24h
const MAX_ORDERS_PER_PAIR = 500;
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;  // 5 min

class OrderBook extends EventEmitter {
    constructor() {
        super();
        // Index: "fromChain:fromToken:toChain:toToken" → Set de swapIds
        this.index = new Map();

        // Cache: swapId → order (público)
        this.orders = new Map();

        // Índice por maker
        this.byMaker = new Map();

        this._cleanupInterval = null;
    }

    // ============================================
    // INDEXAÇÃO
    // ============================================
    _pairKey(fromChain, fromToken, toChain, toToken) {
        return `${fromChain}:${fromToken}:${toChain}:${toToken}`.toLowerCase();
    }

    _reverseKey(fromChain, fromToken, toChain, toToken) {
        return `${toChain}:${toToken}:${fromChain}:${fromToken}`.toLowerCase();
    }

    // ============================================
    // ADICIONAR / ATUALIZAR
    // ============================================
    addOrder(order) {
        if (!order || !order.swapId) throw new Error('order inválida');
        if (order.status !== 'open' && order.status !== 'matched') {
            return false;
        }

        const swapId = order.swapId;
        const makerAddr = order.maker?.address;
        const key = this._pairKey(order.fromChain, order.fromToken, order.toChain, order.toToken);

        // Já existe? atualiza
        if (this.orders.has(swapId)) {
            this.orders.set(swapId, order);
            this.emit('order:updated', order);
            return true;
        }

        // Adiciona
        this.orders.set(swapId, order);

        if (!this.index.has(key)) this.index.set(key, new Set());
        this.index.get(key).add(swapId);

        if (makerAddr) {
            if (!this.byMaker.has(makerAddr)) this.byMaker.set(makerAddr, new Set());
            this.byMaker.get(makerAddr).add(swapId);
        }

        // Limita tamanho
        const pairSet = this.index.get(key);
        if (pairSet.size > MAX_ORDERS_PER_PAIR) {
            // Remove a mais antiga
            const oldest = this._findOldest(pairSet);
            if (oldest) this.removeOrder(oldest);
        }

        this.emit('order:added', order);
        return true;
    }

    // ============================================
    // REMOVER
    // ============================================
    removeOrder(swapId) {
        const order = this.orders.get(swapId);
        if (!order) return false;

        const key = this._pairKey(order.fromChain, order.fromToken, order.toChain, order.toToken);

        if (this.index.has(key)) {
            this.index.get(key).delete(swapId);
            if (this.index.get(key).size === 0) this.index.delete(key);
        }

        const makerAddr = order.maker?.address;
        if (makerAddr && this.byMaker.has(makerAddr)) {
            this.byMaker.get(makerAddr).delete(swapId);
            if (this.byMaker.get(makerAddr).size === 0) this.byMaker.delete(makerAddr);
        }

        this.orders.delete(swapId);
        this.emit('order:removed', swapId);
        return true;
    }

    // ============================================
    // BUSCAR ORDENS
    // ============================================
    /**
     * Busca ordens que combinam com o par.
     *
     * @param {Object} query
     * @param {string} query.fromChain    - chain que o taker QUER ENVIAR
     * @param {string} query.toChain      - chain que o taker QUER RECEBER
     * @param {string} query.fromToken
     * @param {string} query.toToken
     * @param {number} [query.maxResults]
     * @param {boolean} [query.includeReverse] - incluir par reverso?
     */
    findOrders({ fromChain, fromToken, toChain, toToken, maxResults = 20, includeReverse = true }) {
        const results = [];

        // Busca par direto (maker: from→to, taker quer from→to)
        const directKey = this._pairKey(fromChain, fromToken, toChain, toToken);
        const directIds = this.index.get(directKey);
        if (directIds) {
            for (const id of directIds) {
                const o = this.orders.get(id);
                if (o && o.status === 'open' && new Date(o.expiresAt) > new Date()) {
                    results.push(o);
                }
            }
        }

        // Busca par reverso (maker: to→from, taker aceita fazer o outro lado)
        if (includeReverse) {
            const reverseKey = this._reverseKey(fromChain, fromToken, toChain, toToken);
            const reverseIds = this.index.get(reverseKey);
            if (reverseIds) {
                for (const id of reverseIds) {
                    const o = this.orders.get(id);
                    if (o && o.status === 'open' && new Date(o.expiresAt) > new Date()) {
                        results.push({ ...o, reversed: true });
                    }
                }
            }
        }

        // Ordena por melhor taxa pra quem busca
        results.sort((a, b) => {
            const ra = parseFloat(a.rate);
            const rb = parseFloat(b.rate);
            // Quem busca quer MAIS toToken por fromToken → maior rate
            if (a.reversed) return ra - rb;
            return rb - ra;
        });

        return results.slice(0, maxResults);
    }

    // ============================================
    // QUERIES
    // ============================================
    getOrder(swapId) {
        return this.orders.get(swapId) || null;
    }

    getMakerOrders(makerAddress) {
        const ids = this.byMaker.get(makerAddress);
        if (!ids) return [];
        return Array.from(ids).map(id => this.orders.get(id)).filter(Boolean);
    }

    getAllOrders() {
        return Array.from(this.orders.values());
    }

    getAllPairs() {
        return Array.from(this.index.keys()).map(k => {
            const [fromChain, fromToken, toChain, toToken] = k.split(':');
            return { fromChain, fromToken, toChain, toToken, count: this.index.get(k).size };
        });
    }

    getStats() {
        return {
            totalOrders: this.orders.size,
            totalPairs: this.index.size,
            totalMakers: this.byMaker.size,
            pairs: this.getAllPairs()
        };
    }

    // ============================================
    // SINCRONIZAÇÃO COM MONGO
    // ============================================
    /**
     * Carrega ordens abertas do Mongo (restart do node)
     */
    async loadFromMongo() {
        try {
            const orders = await SwapOrderModel.find({
                status: { $in: ['open', 'matched'] },
                expiresAt: { $gt: new Date() }
            }).limit(MAX_ORDERS_PER_PAIR * 10);

            let loaded = 0;
            for (const o of orders) {
                if (this.addOrder(o.toPublic())) loaded++;
            }

            console.log(`📚 OrderBook: ${loaded} ordens carregadas do Mongo`);
            return loaded;
        } catch (e) {
            console.error('❌ Erro ao carregar order book:', e.message);
            return 0;
        }
    }

    // ============================================
    // LIMPEZA
    // ============================================
    startCleanup(intervalMs = CLEANUP_INTERVAL_MS) {
        if (this._cleanupInterval) return;

        this._cleanupInterval = setInterval(() => {
            this._cleanup();
        }, intervalMs);

        console.log(`🧹 OrderBook cleanup iniciado (${intervalMs}ms)`);
    }

    stopCleanup() {
        if (this._cleanupInterval) {
            clearInterval(this._cleanupInterval);
            this._cleanupInterval = null;
        }
    }

    _cleanup() {
        const now = Date.now();
        let removed = 0;

        for (const [swapId, order] of this.orders.entries()) {
            const expiresAt = new Date(order.expiresAt).getTime();

            if (expiresAt < now) {
                this.removeOrder(swapId);
                removed++;
                continue;
            }

            if (order.status !== 'open' && order.status !== 'matched') {
                this.removeOrder(swapId);
                removed++;
            }
        }

        if (removed > 0) {
            console.log(`🧹 OrderBook: ${removed} ordens expiradas removidas`);
        }
    }

    _findOldest(swapIdSet) {
        let oldest = null;
        let oldestTs = Infinity;

        for (const id of swapIdSet) {
            const o = this.orders.get(id);
            if (!o) continue;
            const ts = new Date(o.createdAt || o.expiresAt).getTime();
            if (ts < oldestTs) {
                oldestTs = ts;
                oldest = id;
            }
        }

        return oldest;
    }
}

module.exports = new OrderBook();
module.exports.OrderBook = OrderBook;
