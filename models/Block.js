// models/Block.js
// ============================================
// Schema de Bloco - Bradicoin
// ============================================

const mongoose = require('mongoose');

const blockTransactionSchema = new mongoose.Schema({
    hash: { type: String, required: true },
    fromAddress: { type: String, default: null },
    toAddress: { type: String, required: true },
    amount: { type: String, required: true }, // string para preservar precisão
    fee: { type: String, default: '0' },
    nonce: { type: Number, default: 0 },
    type: { type: String, default: 'transfer' },
    signature: { type: String },
    publicKey: { type: String }
}, { _id: false });

const blockSchema = new mongoose.Schema({
    index: {
        type: Number,
        required: true,
        unique: true,
        index: true
    },
    timestamp: {
        type: String,
        required: true
    },
    transactions: {
        type: [blockTransactionSchema],
        default: []
    },
    previousHash: {
        type: String,
        required: true
    },
    hash: {
        type: String,
        required: true,
        unique: true,
        index: true
    },
    nonce: {
        type: Number,
        default: 0
    },
    minerAddress: {
        type: String,
        default: null
    },
    minerSignature: {
        type: String,
        default: null
    }
}, {
    timestamps: true
});

blockSchema.index({ index: 1 }, { unique: true });
blockSchema.index({ hash: 1 }, { unique: true });
blockSchema.index({ timestamp: -1 });

module.exports = mongoose.model('Block', blockSchema);
