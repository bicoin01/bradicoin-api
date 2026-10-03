// models/Wallet.js
// ============================================
// Schema da Carteira - Bradicoin (v2.1)
// ============================================
// 🆕 v2.1 — revertDebit / revertCredit (reorg-safe)
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

        balance: {
            type: Decimal128,
            default: () => Decimal128.fromString('0'),
            required: true
        },

        nonce: {
            type: Number,
            default: 0,
            required: true,
            min: 0
        },

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

        lastAirdropAt: {
            type: Date,
            default: null
        },

        totalAirdropsClaimed: {
            type: Number,
            default: 0,
            min: 0
        },

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
                delete ret.publicKey;

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

walletSchema.methods.canClaimAirdrop = function () {
    if (!this.lastAirdropAt) return true;
    const SIX_HOURS = 6 * 60 * 60 * 1000;
    return Date.now() - this.lastAirdropAt.getTime() >= SIX_HOURS;
};

walletSchema.methods.timeUntilNextAirdrop = function () {
    if (!this.lastAirdropAt) return 0;
    const SIX_HOURS = 6 * 60 * 60 * 1000;
    const elapsed = Date.now() - this.lastAirdropAt.getTime();
    return Math.max(0, SIX_HOURS - elapsed);
};

walletSchema.methods.getBalanceNumber = function () {
    return parseFloat(this.balance.toString());
};

// ============================================
// MÉTODOS ESTÁTICOS (operações atômicas)
// ============================================

// 🔐 DEBITAR
// ⚠️ NÃO use para reverter: use revertDebit
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
                totalSent: amountDecimal
            }
        },
        options
    );

    if (!wallet) {
        throw new Error('Saldo insuficiente, carteira inativa ou não encontrada');
    }

    return wallet;
};

// 🔐 CREDITAR
// ⚠️ NÃO use para reverter: use revertCredit
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

// 🔁 REVERTER DÉBITO (reorg-safe)
// Devolve saldo ao from e decrementa o nonce
walletSchema.statics.revertDebit = async function (address, amountStr, session = null) {
    const amountDecimal = Decimal128.fromString(amountStr.toString());

    const options = { new: true };
    if (session) options.session = session;

    const wallet = await this.findOneAndUpdate(
        { address },
        {
            $inc: {
                balance: amountDecimal,
                nonce: -1,
                txCount: -1,
                totalSent: Decimal128.fromString(`-${amountStr}`)
            }
        },
        options
    );

    if (!wallet) {
        throw new Error(`revertDebit: carteira ${address} não encontrada`);
    }

    return wallet;
};

// 🔁 REVERTER CRÉDITO (reorg-safe)
// Retira saldo do to (o nonce dele NÃO foi mexido no credit, então não mexe aqui)
walletSchema.statics.revertCredit = async function (address, amountStr, session = null) {
    const amountDecimal = Decimal128.fromString(amountStr.toString());

    const options = { new: true };
    if (session) options.session = session;

    const wallet = await this.findOneAndUpdate(
        { address },
        {
            $inc: {
                balance: Decimal128.fromString(`-${amountStr}`),
                txCount: -1,
                totalReceived: Decimal128.fromString(`-${amountStr}`)
            }
        },
        options
    );

    if (!wallet) {
        throw new Error(`revertCredit: carteira ${address} não encontrada`);
    }

    return wallet;
};

// 🔐 INCREMENTAR NONCE (validação com expectedNonce)
walletSchema.statics.incrementNonce = async function (address, expectedNonce) {
    const wallet = await this.findOneAndUpdate(
        {
            address,
            nonce: expectedNonce
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
