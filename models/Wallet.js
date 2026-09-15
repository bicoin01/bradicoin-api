// models/Wallet.js
// ============================================
// Schema da Carteira - Bradicoin (v2.0)
// ============================================

const mongoose = require('mongoose');
const { Decimal128 } = mongoose.Schema.Types;

const walletSchema = new mongoose.Schema(
    {
        userId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: true,
            unique: true,
            index: true
        },

        address: {
            type: String,
            required: true,
            unique: true,
            index: true,
            validate: {
                validator: function (v) {
                    return /^Br[a-fA-F0-9]{38}$/.test(v);
                },
                message: 'Endereço deve ter o formato Br + 38 caracteres hexadecimais'
            }
        },

        // 🔐 Chave pública secp256k1 comprimida (66 chars hex)
        // Usada para verificar assinaturas de transações
        publicKey: {
            type: String,
            required: true,
            validate: {
                validator: function (v) {
                    return /^[a-fA-F0-9]{66}$/.test(v);
                },
                message: 'Public key deve ter 66 caracteres hexadecimais (secp256k1 comprimida)'
            }
        },

        // ============================================
        // 💰 SALDO (Decimal128 para precisão)
        // ============================================
        balance: {
            type: Decimal128,
            default: () => Decimal128.fromString('0'),
            required: true
        },

        // ============================================
        // 🔐 NONCE (anti-replay attack)
        // ============================================
        // Incrementa a cada transação enviada.
        // Backend só aceita TX com nonce === wallet.nonce
        nonce: {
            type: Number,
            default: 0,
            required: true,
            min: 0
        },

        // ============================================
        // 📊 ESTATÍSTICAS
        // ============================================
        totalSent: {
            type: Decimal128,
            default: () => Decimal128.fromString('0')
        },

        totalReceived: {
            type: Decimal128,
            default: () => Decimal128.fromString('0')
        },

        totalFeesPaid: {
            type: Decimal128,
            default: () => Decimal128.fromString('0')
        },

        txCount: {
            type: Number,
            default: 0,
            min: 0
        },

        // ============================================
        // 🎁 AIRDROPS
        // ============================================
        lastAirdropAt: {
            type: Date,
            default: null
        },

        totalAirdropsClaimed: {
            type: Number,
            default: 0,
            min: 0
        },

        // ============================================
        // 🚦 STATUS
        // ============================================
        status: {
            type: String,
            enum: ['active', 'frozen', 'closed'],
            default: 'active',
            index: true
        }
    },
    {
        timestamps: true,

        toJSON: {
            transform(doc, ret) {
                delete ret.__v;
                delete ret.publicKey; // não expor em APIs públicas

                // Converte Decimal128 para string (JSON não suporta)
                if (ret.balance) ret.balance = ret.balance.toString();
                if (ret.totalSent) ret.totalSent = ret.totalSent.toString();
                if (ret.totalReceived) ret.totalReceived = ret.totalReceived.toString();
                if (ret.totalFeesPaid) ret.totalFeesPaid = ret.totalFeesPaid.toString();

                return ret;
            }
        },

        toObject: {
            transform(doc, ret) {
                delete ret.__v;
                delete ret.publicKey;

                if (ret.balance) ret.balance = ret.balance.toString();
                if (ret.totalSent) ret.totalSent = ret.totalSent.toString();
                if (ret.totalReceived) ret.totalReceived = ret.totalReceived.toString();
                if (ret.totalFeesPaid) ret.totalFeesPaid = ret.totalFeesPaid.toString();

                return ret;
            }
        }
    }
);

// ============================================
// MÉTODOS DE INSTÂNCIA
// ============================================

// Retorna dados públicos (para API)
walletSchema.methods.toPublic = function () {
    return {
        id: this._id,
        address: this.address,
        balance: this.balance.toString(),
        nonce: this.nonce,
        totalSent: this.totalSent.toString(),
        totalReceived: this.totalReceived.toString(),
        totalFeesPaid: this.totalFeesPaid.toString(),
        txCount: this.txCount,
        status: this.status,
        createdAt: this.createdAt,
        lastAirdropAt: this.lastAirdropAt
    };
};

// Verifica se pode pegar airdrop (cooldown 6h)
walletSchema.methods.canClaimAirdrop = function () {
    if (!this.lastAirdropAt) return true;
    const SIX_HOURS = 6 * 60 * 60 * 1000;
    return Date.now() - this.lastAirdropAt.getTime() >= SIX_HOURS;
};

// Tempo até o próximo airdrop (ms)
walletSchema.methods.timeUntilNextAirdrop = function () {
    if (!this.lastAirdropAt) return 0;
    const SIX_HOURS = 6 * 60 * 60 * 1000;
    const elapsed = Date.now() - this.lastAirdropAt.getTime();
    return Math.max(0, SIX_HOURS - elapsed);
};

// Helper: retorna saldo como number (para cálculos internos)
walletSchema.methods.getBalanceNumber = function () {
    return parseFloat(this.balance.toString());
};

// ============================================
// MÉTODOS ESTÁTICOS (operações atômicas)
// ============================================

// 🔐 DEBITAR (atômico — sem race condition)
// Uso: await Wallet.debit('BrABC...', '100.50')
walletSchema.statics.debit = async function (address, amountStr, session = null) {
    const amountDecimal = Decimal128.fromString(amountStr.toString());

    const options = { new: true };
    if (session) options.session = session;

    const wallet = await this.findOneAndUpdate(
        {
            address,
            status: 'active',
            balance: { $gte: amountDecimal }
        },
        {
            $inc: {
                balance: Decimal128.fromString(`-${amountStr}`),
                nonce: 1,
                txCount: 1,
                totalSent: Decimal128.fromString(`${amountStr}`)
            }
        },
        options
    );

    if (!wallet) {
        throw new Error('Saldo insuficiente, carteira inativa ou não encontrada');
    }

    return wallet;
};

// 🔐 CREDITAR (atômico)
walletSchema.statics.credit = async function (address, amountStr, session = null) {
    const amountDecimal = Decimal128.fromString(amountStr.toString());

    const options = { new: true };
    if (session) options.session = session;

    const wallet = await this.findOneAndUpdate(
        { address, status: 'active' },
        {
            $inc: {
                balance: amountDecimal,
                txCount: 1,
                totalReceived: amountDecimal
            }
        },
        options
    );

    if (!wallet) {
        throw new Error('Carteira não encontrada ou inativa');
    }

    return wallet;
};

// 🔐 INCREMENTAR NONCE (para validar TX)
walletSchema.statics.incrementNonce = async function (address, expectedNonce) {
    const wallet = await this.findOneAndUpdate(
        {
            address,
            nonce: expectedNonce // só incrementa se o nonce bater
        },
        {
            $inc: { nonce: 1 }
        },
        { new: true }
    );

    if (!wallet) {
        throw new Error('Nonce inválido (possível replay attack)');
    }

    return wallet;
};

// ============================================
// ÍNDICES
// ============================================

walletSchema.index({ userId: 1 }, { unique: true });
walletSchema.index({ address: 1 }, { unique: true });
walletSchema.index({ status: 1 });
walletSchema.index({ createdAt: -1 });

module.exports = mongoose.model('Wallet', walletSchema);
