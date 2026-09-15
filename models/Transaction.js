// models/Transaction.js
// ============================================
// Schema de Transação - Bradicoin (v2.0)
// ============================================

const mongoose = require('mongoose');
const { Decimal128 } = mongoose.Schema.Types;

const transactionSchema = new mongoose.Schema(
    {
        // ============================================
        // 🔑 IDENTIFICADORES
        // ============================================
        hash: {
            type: String,
            required: true,
            unique: true,
            index: true,
            validate: {
                validator: function (v) {
                    return /^[a-fA-F0-9]{64}$/.test(v); // SHA-256 = 64 hex
                },
                message: 'Hash deve ter 64 caracteres hexadecimais (SHA-256)'
            }
        },

        // ============================================
        // 👤 ORIGEM E DESTINO
        // ============================================
        from: {
            type: String,
            required: true,
            index: true,
            validate: {
                validator: function (v) {
                    // null = sistema (mint/airdrop/reward)
                    if (v === null) return true;
                    return /^Br[a-fA-F0-9]{38}$/.test(v);
                },
                message: 'Endereço de origem inválido'
            }
        },

        to: {
            type: String,
            required: true,
            index: true,
            validate: {
                validator: function (v) {
                    return /^Br[a-fA-F0-9]{38}$/.test(v);
                },
                message: 'Endereço de destino inválido'
            }
        },

        // ============================================
        // 💰 VALORES (Decimal128)
        // ============================================
        amount: {
            type: Decimal128,
            required: true,
            validate: {
                validator: function (v) {
                    return parseFloat(v.toString()) > 0;
                },
                message: 'Valor deve ser positivo'
            }
        },

        fee: {
            type: Decimal128,
            default: () => Decimal128.fromString('0')
        },

        // ============================================
        // 🔐 ASSINATURA CRIPTOGRÁFICA
        // ============================================
        signature: {
            type: String,
            required: true,
            index: true,
            validate: {
                validator: function (v) {
                    return /^[a-fA-F0-9]+$/.test(v);
                },
                message: 'Assinatura deve ser hexadecimal'
            }
        },

        publicKey: {
            type: String,
            required: true,
            validate: {
                validator: function (v) {
                    return /^[a-fA-F0-9]{66}$/.test(v); // secp256k1 comprimida
                },
                message: 'Public key deve ter 66 caracteres hexadecimais'
            }
        },

        // ============================================
        // 🔐 NONCE (anti-replay)
        // ============================================
        nonce: {
            type: Number,
            required: true,
            min: 0,
            index: true
        },

        // ============================================
        // 📋 TIPO DE TRANSAÇÃO
        // ============================================
        type: {
            type: String,
            required: true,
            enum: [
                'transfer',      // envio normal
                'stake',         // entrada em stake
                'unstake',       // saída de stake
                'reward',        // recompensa de staking
                'airdrop',       // distribuição grátis
                'mint',          // criação de tokens
                'burn',          // queima de tokens
                'wallet_creation', // criação de carteira
                'tip',           // gorjeta
                'nft_mint',      // criação de NFT
                'nft_transfer'   // transferência de NFT
            ],
            default: 'transfer',
            index: true
        },

        // ============================================
        // 🚦 STATUS
        // ============================================
        status: {
            type: String,
            enum: ['pending', 'confirmed', 'failed'],
            default: 'pending',
            index: true
        },

        // ============================================
        // 📦 BLOCO
        // ============================================
        blockIndex: {
            type: Number,
            default: null,
            index: true
        },

        blockHash: {
            type: String,
            default: null
        },

        confirmations: {
            type: Number,
            default: 0
        },

        // ============================================
        // 📊 METADADOS
        // ============================================
        metadata: {
            stakeId: {
                type: mongoose.Schema.Types.ObjectId,
                ref: 'ReserveStake'
            },
            poolKey: String,
            message: {
                type: String,
                maxlength: 500
            },
            reason: String, // para falhas
            ip: {
                type: String,
                maxlength: 45
            }
        },

        // ============================================
        // ⏰ TIMESTAMP
        // ============================================
        timestamp: {
            type: Date,
            required: true,
            default: Date.now,
            index: true
        }
    },
    {
        timestamps: true,

        toJSON: {
            transform(doc, ret) {
                delete ret.__v;

                // Converte Decimal128 para string
                if (ret.amount) ret.amount = ret.amount.toString();
                if (ret.fee) ret.fee = ret.fee.toString();

                return ret;
            }
        },

        toObject: {
            transform(doc, ret) {
                delete ret.__v;

                if (ret.amount) ret.amount = ret.amount.toString();
                if (ret.fee) ret.fee = ret.fee.toString();

                return ret;
            }
        }
    }
);

// ============================================
// ÍNDICES
// ============================================

// Busca por hash (único globalmente)
transactionSchema.index({ hash: 1 }, { unique: true });

// 🔐 ANTI-REPLAY: assinatura única (nunca repete)
transactionSchema.index(
    { signature: 1 },
    { unique: true, name: 'unique_signature' }
);

// 🔐 Anti-replay: nonce + from únicos
transactionSchema.index(
    { from: 1, nonce: 1 },
    { unique: true, name: 'unique_from_nonce' }
);

// Histórico de uma carteira
transactionSchema.index({ from: 1, timestamp: -1 });
transactionSchema.index({ to: 1, timestamp: -1 });

// Listagem por status
transactionSchema.index({ status: 1, timestamp: -1 });

// Blocos
transactionSchema.index({ blockIndex: 1, timestamp: -1 });

// Tipo
transactionSchema.index({ type: 1, timestamp: -1 });

// ============================================
// MÉTODOS DE INSTÂNCIA
// ============================================

// Retorna dados públicos
transactionSchema.methods.toPublic = function () {
    return {
        id: this._id,
        hash: this.hash,
        from: this.from,
        to: this.to,
        amount: this.amount.toString(),
        fee: this.fee.toString(),
        type: this.type,
        status: this.status,
        nonce: this.nonce,
        blockIndex: this.blockIndex,
        blockHash: this.blockHash,
        confirmations: this.confirmations,
        timestamp: this.timestamp,
        createdAt: this.createdAt
    };
};

// Verifica se está confirmada
transactionSchema.methods.isConfirmed = function () {
    return this.status === 'confirmed';
};

// Verifica se está pendente
transactionSchema.methods.isPending = function () {
    return this.status === 'pending';
};

// ============================================
// MÉTODOS ESTÁTICOS
// ============================================

// Busca por hash
transactionSchema.statics.findByHash = async function (hash) {
    return this.findOne({ hash });
};

// Busca transações de uma carteira (from OR to)
transactionSchema.statics.findByAddress = async function (address, limit = 50, offset = 0) {
    return this.find({
        $or: [{ from: address }, { to: address }]
    })
        .sort({ timestamp: -1 })
        .skip(offset)
        .limit(limit)
        .lean();
};

// Conta total de TX de uma carteira
transactionSchema.statics.countByAddress = async function (address) {
    return this.countDocuments({
        $or: [{ from: address }, { to: address }]
    });
};

// Lista transações pendentes
transactionSchema.statics.findPending = async function (limit = 100) {
    return this.find({ status: 'pending' })
        .sort({ timestamp: 1 })
        .limit(limit)
        .lean();
};

// Verifica se nonce foi usado (anti-replay)
transactionSchema.statics.isNonceUsed = async function (address, nonce) {
    const tx = await this.findOne({ from: address, nonce });
    return !!tx;
};

// ============================================
// EXPORTS
// ============================================

module.exports = mongoose.model('Transaction', transactionSchema);
