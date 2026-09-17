// models/Token.js
const mongoose = require('mongoose');

const TokenSchema = new mongoose.Schema(
    {
        ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
        ownerAddress: { type: String, required: true, lowercase: true, index: true },
        name: { type: String, required: true, trim: true, maxlength: 64 },
        symbol: { type: String, required: true, uppercase: true, trim: true, maxlength: 10 },
        supply: { type: Number, required: true, min: 1 },
        price: { type: Number, default: 1.5 },
        logo: { type: String, default: null },
        description: { type: String, default: '', maxlength: 500 },
        listed: { type: Boolean, default: true, index: true },
        mintFee: { type: Number, default: 0.016 },
        txHash: { type: String, default: null }
    },
    { timestamps: true }
);

TokenSchema.index({ symbol: 1 }, { unique: true });

TokenSchema.methods.toPublic = function () {
    return {
        id: this._id,
        name: this.name,
        symbol: this.symbol,
        supply: this.supply,
        price: this.price,
        logo: this.logo,
        description: this.description,
        ownerAddress: this.ownerAddress,
        listed: this.listed,
        txHash: this.txHash,
        createdAt: this.createdAt
    };
};

module.exports = mongoose.model('Token', TokenSchema);
