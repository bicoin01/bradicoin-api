// controllers/buy.js
// ============================================
// API de compra de BradiCoin (Fase 1: BNB + USDT-BEP20)
// ============================================
// POST   /api/v1/buy/create       → cria pedido + endereço de depósito
// GET    /api/v1/buy/:orderId     → status do pedido (polling do front)
// GET    /api/v1/buy/me           → lista pedidos do usuário
// ============================================

const mongoose = require('mongoose');
const BuyOrder = require('../models/BuyOrder');
const Wallet = require('../models/Wallet');
const deposit = require('../services/buy/depositAddress');
const { logger } = require('../middleware/error');

// ============================================
// CONFIG
// ============================================
const EXPIRY_MINUTES = parseInt(
    process.env.BUY_DEPOSIT_EXPIRY_MINUTES || '30',
    10
);
const MIN_AMOUNT_USD = parseFloat(process.env.BUY_MIN_AMOUNT_USD || '5');

// Cotações fixas por enquanto (Fase 1). Fase 2: priceEngine.
const PRICE_BRD_USD = 10;
const PRICE_PAYMENT_USD = {
    BNB: 600,
    ETH: 3000,
    USDT: 1,
    SOL: 150,
};

// Redes permitidas por moeda (Fase 1: só EVM/BSC)
const ALLOWED_NETWORKS = {
    BNB:  ['bsc'],
    ETH:  ['ethereum'],
    USDT: ['bsc', 'ethereum'],
    SOL:  ['solana'],
};

// Decimais por moeda pra converter valor esperado
const PAYMENT_DECIMALS = {
    BNB: 18,
    ETH: 18,
    USDT_BSC: 18,       // BEP-20 USDT usa 18 decimals
    USDT_ETH: 6,         // ERC-20 USDT usa 6 decimals ⚠️ diferente!
    SOL: 9,
};

function networkLabel(currency, network) {
    if (currency === 'USDT') {
        return network === 'bsc' ? 'BSC (BEP-20)' : 'Ethereum (ERC-20)';
    }
    if (currency === 'BNB') return 'BSC (BEP-20)';
    if (currency === 'ETH') return 'Ethereum';
    if (currency === 'SOL') return 'Solana';
    return network;
}

// ============================================
// HELPERS
// ============================================
function badRequest(res, msg) {
    return res.status(400).json({ success: false, error: msg });
}
function notFound(res, msg) {
    return res.status(404).json({ success: false, error: msg });
}
function serverError(res, msg) {
    return res.status(500).json({ success: false, error: msg });
}

/**
 * Calcula valor esperado em unidades base (wei/tokens)
 * Ex: 0.005 BNB → "5000000000000000" (wei)
 */
function calcExpectedPaymentAmount(currency, network, amountUsd) {
    const priceUsd = PRICE_PAYMENT_USD[currency];
    if (!priceUsd) {
        throw new Error(`Cotação desconhecida pra ${currency}`);
    }

    // amountUsd = quantos dólares o usuário vai pagar
    const amountPayment = amountUsd / priceUsd;
    
    // ===== SOL: lamports (9 decimais) =====
    if (currency === 'SOL') {
        const lamports = BigInt(Math.round(amountPayment * 1e9));
        return {
            amountPayment: amountPayment.toString(),
            baseUnits: lamports.toString(),
            decimals: 9
        };
    }
    
    let decimals;
    if (currency === 'USDT') {
        decimals = network === 'bsc' ? PAYMENT_DECIMALS.USDT_BSC : PAYMENT_DECIMALS.USDT_ETH;
    } else {
        decimals = PAYMENT_DECIMALS[currency];
    }

    if (!Number.isInteger(decimals)) {
        throw new Error(`Decimais desconhecidos pra ${currency}/${network}`);
    }

    // Converte pra unidades base (evita float — usa string)
    const base = BigInt(Math.round(amountPayment * 1e6)) * (10n ** BigInt(decimals - 6));
    return {
        amountPayment: amountPayment.toString(),
        baseUnits: base.toString(),
        decimals
    };
}

// ============================================
// POST /create
// ============================================
async function createOrder(req, res) {
    try {
        const userId = req.user?.id || req.user?._id;
        if (!userId) {
            return res.status(401).json({ success: false, error: 'Não autenticado' });
        }

        const {
            currency,
            paymentNetwork,
            amountBr,
            toWallet,
            fromWallet
        } = req.body || {};

        // ===== 1. VALIDAÇÕES =====
        if (!currency) return badRequest(res, 'currency é obrigatório');
        if (!toWallet) return badRequest(res, 'toWallet é obrigatório');
        if (!amountBr || parseFloat(amountBr) <= 0) {
            return badRequest(res, 'amountBr deve ser > 0');
        }

        const c = String(currency).toUpperCase();
        const n = paymentNetwork ? String(paymentNetwork).toLowerCase() : null;

        // Rede válida?
        if (!ALLOWED_NETWORKS[c]) {
            return badRequest(res, `currency '${c}' não suportada (use BNB, ETH, USDT ou SOL)`);
        }
        if (!n || !ALLOWED_NETWORKS[c].includes(n)) {
            return badRequest(
                res,
                `paymentNetwork inválida pra ${c}. Use: ${ALLOWED_NETWORKS[c].join(', ')}`
            );
        }

        // toWallet formato válido?
        if (!/^Br[a-fA-F0-9]{38}$/.test(toWallet)) {
            return badRequest(res, 'toWallet inválida (formato Br + 38 hex)');
        }

        // toWallet existe e é do usuário?
        const walletDoc = await Wallet.findOne({ address: toWallet });
        if (!walletDoc) {
            return notFound(res, 'Carteira BradiCoin não encontrada');
        }
        if (walletDoc.userId && walletDoc.userId.toString() !== userId.toString()) {
            return res.status(403).json({ success: false, error: 'toWallet não pertence a este usuário' });
        }

        // Valor mínimo
        const amountBrNum = parseFloat(amountBr);
        const amountUsd = amountBrNum * PRICE_BRD_USD;
        if (amountUsd < MIN_AMOUNT_USD) {
            return badRequest(
                res,
                `Valor mínimo: $${MIN_AMOUNT_USD} USD (≈ ${(MIN_AMOUNT_USD / PRICE_BRD_USD).toFixed(2)} BRD)`
            );
        }

        // ===== 2. CALCULA VALOR ESPERADO =====
        let expected;
        try {
            expected = calcExpectedPaymentAmount(c, n, amountUsd);
        } catch (err) {
            return badRequest(res, err.message);
        }

        // ===== 3. RESERVA ÍNDICE HD (com retry em caso de corrida) =====
        let depositIndex = await deposit.nextDepositIndex();
        let depositAddress;
        let order;
        let attempt = 0;
        const maxAttempts = 5;

        while (attempt < maxAttempts) {
            attempt++;
            try {
                depositAddress = deposit.generateDepositAddress(c, n, depositIndex);
            } catch (err) {
                return badRequest(res, err.message);
            }

            const orderId = BuyOrder.generateOrderId();
            const expiresAt = new Date(Date.now() + EXPIRY_MINUTES * 60 * 1000);

            try {
                order = await BuyOrder.create({
                    orderId,
                    userId,
                    currency: c,
                    paymentNetwork: n,
                    amountBr: mongoose.Types.Decimal128.fromString(amountBrNum.toString()),
                    amountUsd,
                    priceAtOrder: PRICE_BRD_USD,
                    toWallet,
                    depositAddress,
                    depositIndex,
                    expectedPaymentAmount: expected.baseUnits,
                    status: 'pending',
                    expiresAt,
                    metadata: {
                        fromWallet: fromWallet || null,
                        paymentDecimals: expected.decimals,
                        ip: req.ip
                    }
                });
                break;
            } catch (err) {
                // Índice duplicado? Tenta próximo.
                if (err.code === 11000 && (err.keyPattern?.depositIndex || err.keyPattern?.['depositIndex'])) {
                    logger.warn(`[buy/create] índice ${depositIndex} já usado, tentando próximo`);
                    depositIndex = await deposit.nextDepositIndex();
                    continue;
                }
                throw err;
            }
        }

        if (!order) {
            return serverError(res, 'Não foi possível reservar um índice HD (tente novamente)');
        }

        logger.info(
            `🛒 Pedido criado: ${order.orderId} — ${c}/${n} ` +
            `$${amountUsd.toFixed(2)} → ${amountBrNum} BRD ` +
            `(índice ${depositIndex}, addr ${depositAddress})`
        );

        // ===== 4. RESPOSTA =====
        return res.status(201).json({
            success: true,
            data: {
                orderId: order.orderId,
                currency: order.currency,
                paymentNetwork: order.paymentNetwork,
                status: order.status,
                depositAddress: order.depositAddress,
                expectedPaymentAmount: order.expectedPaymentAmount,
                paymentDecimals: expected.decimals,
                amountBr: order.amountBr.toString(),
                amountUsd: order.amountUsd,
                priceAtOrder: order.priceAtOrder,
                toWallet: order.toWallet,
                expiresAt: order.expiresAt,
                instructions: {
                    sendExactly: `${expected.amountPayment} ${c}${c === 'USDT' ? ` (${n.toUpperCase()})` : ''}`,
                    toAddress: order.depositAddress,
                    network: n,
                    warning: `Envie APENAS ${c}${c === 'USDT' ? ` (${n.toUpperCase()})` : ''} na rede ${networkLabel(c, n)}. Outra rede = perda total.`
                }
            }
        });
    } catch (err) {
        logger.error(`[buy/create] erro: ${err.message}`);
        return serverError(res, err.message);
    }
}

// ============================================
// GET /:orderId
// ============================================
async function getOrder(req, res) {
    try {
        const userId = req.user?.id || req.user?._id;
        const { orderId } = req.params;

        if (!orderId) return badRequest(res, 'orderId é obrigatório');

        const order = await BuyOrder.findOne({ orderId }).lean();
        if (!order) return notFound(res, 'Pedido não encontrado');

        if (order.userId.toString() !== userId.toString()) {
            return res.status(403).json({ success: false, error: 'Sem permissão' });
        }

        return res.json({
            success: true,
            data: {
                orderId: order.orderId,
                currency: order.currency,
                paymentNetwork: order.paymentNetwork,
                status: order.status,
                depositAddress: order.depositAddress,
                expectedPaymentAmount: order.expectedPaymentAmount,
                paymentAmount: order.paymentAmount,
                paymentTxHash: order.paymentTxHash,
                paymentConfirmations: order.paymentConfirmations,
                amountBr: order.amountBr?.toString(),
                amountUsd: order.amountUsd,
                toWallet: order.toWallet,
                createdAt: order.createdAt,
                detectedAt: order.detectedAt,
                paidAt: order.paidAt,
                creditedAt: order.creditedAt,
                expiresAt: order.expiresAt
            }
        });
    } catch (err) {
        logger.error(`[buy/getOrder] erro: ${err.message}`);
        return serverError(res, err.message);
    }
}

// ============================================
// GET /me
// ============================================
async function myOrders(req, res) {
    try {
        const userId = req.user?.id || req.user?._id;
        const limit = Math.min(parseInt(req.query.limit || '20', 10), 100);
        const skip = Math.max(parseInt(req.query.skip || '0', 10), 0);

        const [orders, total] = await Promise.all([
            BuyOrder.find({ userId })
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit)
                .lean(),
            BuyOrder.countDocuments({ userId })
        ]);

        return res.json({
            success: true,
            data: {
                orders: orders.map(o => ({
                    orderId: o.orderId,
                    currency: o.currency,
                    paymentNetwork: o.paymentNetwork,
                    status: o.status,
                    amountBr: o.amountBr?.toString(),
                    amountUsd: o.amountUsd,
                    depositAddress: o.depositAddress,
                    createdAt: o.createdAt,
                    paidAt: o.paidAt,
                    creditedAt: o.creditedAt,
                    expiresAt: o.expiresAt
                })),
                total,
                limit,
                skip
            }
        });
    } catch (err) {
        logger.error(`[buy/myOrders] erro: ${err.message}`);
        return serverError(res, err.message);
    }
}

// ============================================
// EXPORT
// ============================================
module.exports = {
    createOrder,
    getOrder,
    myOrders
};
