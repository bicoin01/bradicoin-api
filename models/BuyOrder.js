// models/BuyOrder.js
// ============================================
// Pedido de Compra de BradiCoin
// ============================================
// Fluxo:
//   1. Usuário cria pedido (status='pending')
//   2. Usuário paga em BTC/ETH/... (monitor detecta)
//   3. Monitor marca como 'paid'
//   4. creditWorker credita BRD → 'credited'
//
// ============================================

const mongoose = require('mongoose');
const { Decimal128 } = mongoose.Schema.Types;

const buyOrderSchema = new mongoose.Schema(
    {
        // ID único e legível (ex: buy_1731000000000_a1b2c3)
        orderId: {
            type: String,
            required: true,
            unique: true,
            index: true
        },

        // Dono do pedido
        userId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: true,
            index: true
        },

        // Moeda de pagamento: BTC | ETH | SOL | BNB | USDT
        currency: {
            type: String,
            required: true,
            uppercase: true,
            enum: ['BTC', 'ETH', 'SOL', 'BNB', 'USDT']
        },

        // Quanto BRD o usuário quer receber
        amountBr: {
            type: Decimal128,
            required: true,
            validate: {
                validator: (v) => parseFloat(v.toString()) > 0,
                message: 'amountBr deve ser positivo'
            }
        },

        // Valor em USD no momento do pedido (congelado)
        amountUsd: {
            type: Number,
            required: true,
            min: 0
        },

        // Preço BRD/USD no momento do pedido (congelado)
        priceAtOrder: {
            type: Number,
            required: true,
            min: 0
        },

        // Carteira BradiCoin que vai RECEBER os BRD
        toWallet: {
            type: String,
            required: true,
            validate: {
                validator: (v) => /^Br[a-fA-F0-9]{38}$/i.test(v),
                message: 'toWallet inválida (Br + 38 hex)'
            },
            index: true
        },

        // Endereço de depósito (BTC/ETH/etc)
        // ⚠️ Na Fase 1 é fake. Na Fase 2 vem do config.
        depositAddress: {
            type: String,
            required: true
        },

        // Status do pedido
        status: {
            type: String,
            enum: ['pending', 'paid', 'credited', 'expired', 'failed'],
            default: 'pending',
            index: true
        },

        // Hash da tx na moeda de pagamento (BTC/ETH/etc)
        paymentTxHash: {
            type: String,
            default: null
        },

        // Confirmações na blockchain da moeda
        paymentConfirmations: {
            type: Number,
            default: 0,
            min: 0
        },

        // Quando o pagamento foi confirmado
        paidAt: {
            type: Date,
            default: null
        },

        // Hash da tx BRD (preenchido pelo creditWorker)
        creditTxHash: {
            type: String,
            default: null
        },

        // Quando os BRD foram creditados
        creditedAt: {
            type: Date,
            default: null
        },

        // Motivo de falha (se status='failed')
        failureReason: {
            type: String,
            default: null
        },

        // Pedido expira (se não pagar em X min)
        expiresAt: {
            type: Date,
            required: true,
            index: true
        },

        // Metadados extras (origem, IP, etc)
        metadata: {
            type: mongoose.Schema.Types.Mixed,
            default: {}
        }
    },
    {
        timestamps: true,

        toJSON: {
            transform(doc, ret) {
                delete ret.__v;
                if (ret.amountBr) ret.amountBr = ret.amountBr.toString();
                return ret;
            }
        },

        toObject: {
            transform(doc, ret) {
                delete ret.__v;
                if (ret.amountBr) ret.amountBr = ret.amountBr.toString();
                return ret;
            }
        }
    }
);

// ============================================
// ÍNDICES
// ============================================
buyOrderSchema.index({ userId: 1, createdAt: -1 });
buyOrderSchema.index({ status: 1, currency: 1 });
buyOrderSchema.index({ status: 1, expiresAt: 1 });

// ============================================
// MÉTODOS DE INSTÂNCIA
// ============================================

// Verifica se o pedido pode ser pago (não expirou, não foi creditado)
buyOrderSchema.methods.canReceivePayment = function () {
    if (this.status !== 'pending') return false;
    if (this.expiresAt && Date.now() > this.expiresAt.getTime()) return false;
    return true;
};

// Verifica se o pedido está pronto para creditar
buyOrderSchema.methods.canBeCredited = function () {
    return this.status === 'paid' && !this.creditTxHash;
};

// Retorna versão pública (sem dados sensíveis)
buyOrderSchema.methods.toPublic = function () {
    return {
        orderId: this.orderId,
        currency: this.currency,
        amountBr: this.amountBr.toString(),
        amountUsd: this.amountUsd,
        priceAtOrder: this.priceAtOrder,
        toWallet: this.toWallet,
        depositAddress: this.depositAddress,
        status: this.status,
        paymentTxHash: this.paymentTxHash,
        paymentConfirmations: this.paymentConfirmations,
        creditTxHash: this.creditTxHash,
        createdAt: this.createdAt,
        paidAt: this.paidAt,
        creditedAt: this.creditedAt,
        expiresAt: this.expiresAt
    };
};

// ============================================
// MÉTODOS ESTÁTICOS
// ============================================

// Gera um orderId único
buyOrderSchema.statics.generateOrderId = function () {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 8);
    return `buy_${timestamp}_${random}`;
};

// Busca pedidos expirados (para o cron marcar como 'expired')
buyOrderSchema.statics.findExpired = async function () {
    return this.find({
        status: 'pending',
        expiresAt: { $lt: new Date() }
    });
};

// Busca pedidos pagos que precisam ser creditados
buyOrderSchema.statics.findPaid = async function (limit = 50) {
    return this.find({
        status: 'paid',
        creditTxHash: null
    })
        .sort({ paidAt: 1 })
        .limit(limit);
};

// Marca como expirado (atômico — só se ainda estiver pending)
buyOrderSchema.statics.markExpired = async function (orderId) {
    return this.findOneAndUpdate(
        { orderId, status: 'pending' },
        { $set: { status: 'expired' } },
        { new: true }
    );
};

// ============================================
// EXPORT
// ============================================
const BuyOrder = mongoose.model('BuyOrder', buyOrderSchema);

module.exports = BuyOrder;
