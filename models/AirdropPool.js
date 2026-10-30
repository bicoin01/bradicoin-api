// models/AirdropPool.js
// ============================================
// Pool de Airdrop — BradiChain
// ============================================
// Um documento por campanha. Guarda o quanto foi depositado
// (totalDeposited) e o quanto já foi distribuído (totalDistributed).
// O saldo disponível é a diferença.
//
// Fluxo típico:
//   1. Admin deposita:      AirdropPool.deposit('bradicoin-genesis', 10000)
//   2. Usuário resgata:     AirdropPool.tryDebit('bradicoin-genesis', 50)
//   3. Se crédito falhar:   AirdropPool.refund('bradicoin-genesis', 50)
//   4. Pool esvaziou:       AirdropPool.deposit('bradicoin-genesis', 50000)
// ============================================

const mongoose = require('mongoose');

const airdropPoolSchema = new mongoose.Schema(
    {
        campaign: {
            type: String,
            required: true,
            unique: true,
            trim: true,
            index: true
        },

        // Quanto já foi adicionado ao pool (depósitos do admin)
        totalDeposited: {
            type: Number,
            required: true,
            default: 0,
            min: 0
        },

        // Quanto já foi distribuído (soma dos claims completos)
        totalDistributed: {
            type: Number,
            required: true,
            default: 0,
            min: 0
        },

        // Se false, o claim é bloqueado mesmo com saldo
        enabled: {
            type: Boolean,
            default: true
        },

        // Auditoria
        lastDepositAt: { type: Date, default: null },
        lastDistributedAt: { type: Date, default: null },

        // Histórico de depósitos (auditoria)
        // ⚠️ Se crescer muito, migrar para coleção separada AirdropDeposit
        deposits: [
            {
                amount: { type: Number, required: true },
                by: { type: String, default: 'system' },
                at: { type: Date, default: Date.now },
                note: { type: String, default: '' }
            }
        ]
    },
    {
        timestamps: true // createdAt, updatedAt automáticos
    }
);

// ============================================
// MÉTODOS DE INSTÂNCIA
// ============================================

/**
 * Saldo disponível no pool.
 */
airdropPoolSchema.methods.remaining = function () {
    return Math.max(0, this.totalDeposited - this.totalDistributed);
};

/**
 * Verifica se há saldo suficiente para um claim.
 */
airdropPoolSchema.methods.canPay = function (amount) {
    return this.enabled && this.remaining() >= amount;
};

/**
 * Registra uma distribuição (chamado APÓS o crédito dar certo).
 * ⚠️ NÃO use isso antes do crédito — se o crédito falhar, o pool fica inconsistente.
 * Prefira sempre o estático atômico `tryDebit`.
 */
airdropPoolSchema.methods.recordDistribution = async function (amount) {
    if (amount <= 0) throw new Error('amount inválido');
    this.totalDistributed += amount;
    this.lastDistributedAt = new Date();
    await this.save();
    return this;
};

/**
 * Registra um depósito do admin (versão instância).
 * Prefira sempre o estático atômico `deposit`.
 */
airdropPoolSchema.methods.recordDeposit = async function (amount, by = 'system', note = '') {
    if (amount <= 0) throw new Error('amount inválido');
    this.totalDeposited += amount;
    this.lastDepositAt = new Date();
    this.deposits.push({ amount, by, note, at: new Date() });
    await this.save();
    return this;
};

// ============================================
// MÉTODOS ESTÁTICOS
// ============================================

/**
 * Busca o pool de uma campanha. Retorna null se não existir.
 */
airdropPoolSchema.statics.findByCampaign = function (campaign) {
    return this.findOne({ campaign });
};

/**
 * Cria o pool de uma campanha se não existir. Retorna o documento.
 * Idempotente — pode chamar quantas vezes quiser.
 */
airdropPoolSchema.statics.ensure = async function (campaign, initialDeposited = 0) {
    return this.findOneAndUpdate(
        { campaign },
        {
            $setOnInsert: {
                campaign,
                totalDeposited: initialDeposited,
                totalDistributed: 0,
                enabled: true
            }
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
    );
};

/**
 * 🔥 ATOMIC — Tenta debitar `amount` do pool, garantindo que não fica negativo.
 * Retorna o documento atualizado, ou null se o saldo era insuficiente.
 *
 * Isso é o coração do sistema: previne corrida entre dois claims simultâneos.
 * O uso de $expr na query faz a verificação e o débito numa única operação atômica.
 */
airdropPoolSchema.statics.tryDebit = async function (campaign, amount) {
    if (amount <= 0) throw new Error('amount inválido');

    return this.findOneAndUpdate(
        {
            campaign,
            enabled: true,
            $expr: {
                $gte: [
                    { $subtract: ['$totalDeposited', '$totalDistributed'] },
                    amount
                ]
            }
        },
        {
            $inc: { totalDistributed: amount },
            $set: { lastDistributedAt: new Date() }
        },
        { new: true }
    );
};

/**
 * Reverte um débito (usar se o crédito ao usuário falhar depois do tryDebit).
 */
airdropPoolSchema.statics.refund = async function (campaign, amount) {
    if (amount <= 0) throw new Error('amount inválido');
    return this.findOneAndUpdate(
        { campaign },
        { $inc: { totalDistributed: -amount } },
        { new: true }
    );
};

/**
 * Adiciona fundos ao pool (chamado pelo admin).
 * Cria o documento se não existir.
 */
airdropPoolSchema.statics.deposit = async function (campaign, amount, by = 'system', note = '') {
    if (amount <= 0) throw new Error('amount inválido');

    return this.findOneAndUpdate(
        { campaign },
        {
            $inc: { totalDeposited: amount },
            $set: { lastDepositAt: new Date() },
            $push: { deposits: { amount, by, note, at: new Date() } }
        },
        { new: true, upsert: true, setDefaultsOnInsert: true }
    );
};

/**
 * Pausa/retoma o airdrop de uma campanha sem zerar o saldo.
 */
airdropPoolSchema.statics.setEnabled = async function (campaign, enabled) {
    return this.findOneAndUpdate(
        { campaign },
        { $set: { enabled: Boolean(enabled) } },
        { new: true }
    );
};

// ============================================
// MIDDLEWARE / SANITY
// ============================================

// Garante que totalDistributed nunca ultrapasse totalDeposited
airdropPoolSchema.pre('save', function (next) {
    if (this.totalDistributed > this.totalDeposited) {
        return next(
            new Error(
                `AirdropPool inconsistente: totalDistributed (${this.totalDistributed}) > totalDeposited (${this.totalDeposited})`
            )
        );
    }
    next();
});

module.exports = mongoose.model('AirdropPool', airdropPoolSchema);
