// atomic-swap/negotiation/matcher.js
// ============================================
// Matcher — Encontra ordens compatíveis
// ============================================
// Dado um par desejado, encontra as melhores ordens.
// Considera tanto par direto quanto reverso.
// ============================================

const orderBook = require('./orderBook');

class Matcher {
    constructor({ minProfitBps = 5 } = {}) {
        this.minProfitBps = minProfitBps;
    }

    /**
     * Busca melhores matches pra um par.
     *
     * @param {Object} query
     * @param {string} query.fromChain
     * @param {string} query.fromToken
     * @param {string} query.toChain
     * @param {string} query.toToken
     * @param {string|number} [query.amountIn]  - quanto o taker quer enviar
     * @param {number} [query.maxResults]
     * @returns {Array} matches ordenados por melhor preço
     */
    findMatches({ fromChain, fromToken, toChain, toToken, amountIn, maxResults = 10 }) {
        const orders = orderBook.findOrders({
            fromChain,
            fromToken,
            toChain,
            toToken,
            maxResults: maxResults * 3   // busca mais, filtra depois
        });

        const matches = [];

        for (const order of orders) {
            const analysis = this._analyzeOrder(order, {
                fromChain, fromToken, toChain, toToken, amountIn
            });

            if (analysis.viable) {
                matches.push(analysis);
            }
        }

        // Ordena por melhor taxa pro taker
        matches.sort((a, b) => b.effectiveRate - a.effectiveRate);

        return matches.slice(0, maxResults);
    }

    /**
     * Analisa uma ordem específica.
     */
    _analyzeOrder(order, query) {
        const rate = parseFloat(order.rate);

        // Verifica se é o par reverso
        const isReversed = order.fromChain === query.toChain
                        && order.toChain === query.fromChain
                        && order.fromToken === query.toToken
                        && order.toToken === query.fromToken;

        let effectiveRate;
        let effectivePair;

        if (isReversed) {
            // Par reverso: taker quer (fromToken→toToken) mas maker tem (toToken→fromToken)
            // Taker aceita fazer o lado oposto
            effectiveRate = 1 / rate;   // inverte
            effectivePair = {
                makerGives: order.toToken,
                makerWants: order.fromToken,
                takerGives: order.fromToken,
                takerWants: order.toToken
            };
        } else {
            // Par direto
            effectiveRate = rate;
            effectivePair = {
                makerGives: order.fromToken,
                makerWants: order.toToken,
                takerGives: order.fromToken,
                takerWants: order.toToken
            };
        }

        // Verifica se amountIn é suficiente
        const orderAmount = parseFloat(order.maker.amount);

        let viable = true;
        let reason = null;

        if (query.amountIn) {
            const amountNum = parseFloat(query.amountIn);

            if (isReversed) {
                // No par reverso, o taker precisa ter o valor que o maker quer (toToken)
                if (amountNum < parseFloat(order.taker.amount || order.maker.amount)) {
                    viable = false;
                    reason = `amountIn muito baixo (precisa >= ${order.taker.amount})`;
                }
            } else {
                if (amountNum < orderAmount) {
                    viable = false;
                    reason = `amountIn muito baixo (precisa >= ${orderAmount})`;
                }
            }
        }

        // Calcula output estimado
        let estimatedOutput = null;
        if (query.amountIn) {
            const amt = parseFloat(query.amountIn);
            estimatedOutput = isReversed ? amt * (1 / rate) : amt * rate;
        }

        return {
            swapId: order.swapId,
            maker: order.maker,
            taker: order.taker,
            fromChain: order.fromChain,
            toChain: order.toChain,
            fromToken: order.fromToken,
            toToken: order.toToken,
            rate: order.rate,
            effectiveRate,
            estimatedOutput,
            isReversed,
            effectivePair,
            viable,
            reason,
            expiresAt: order.expires
