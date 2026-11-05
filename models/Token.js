// models/Token.js
const mongoose = require('mongoose');
const { Decimal128 } = mongoose.Schema.Types;

const TokenSchema = new mongoose.Schema({
    tokenId:     { type: String, required: true, unique: true, index: true },
    name:        { type: String, required: true, maxlength: 64 },
    symbol:      { type: String, required: true, uppercase: true, maxlength: 16, index: true },
    totalSupply: { type: Decimal128, required: true },
    decimals:    { type: Number, default: 0, min: 0, max: 18 },
    creator:     { type: String, required: true, index: true },
    txHash:      { type: String, required: true, unique: true },
    logo:        { type: String, default: null },
    status:      { type: String, enum: ['active', 'frozen'], default: 'active' },

    balances: [{
        address: { type: String, required: true },
        amount:  { type: Decimal128, required: true, default: 0 }
    }],

    createdAt:   { type: Date, default: Date.now }
}, { timestamps: true });

TokenSchema.index({ 'balances.address': 1 });
TokenSchema.index({ status: 1, createdAt: -1 });

TokenSchema.methods.getBalance = function(address) {
    const entry = this.balances.find(b => b.address === address);
    return entry ? parseFloat(entry.amount.toString()) : 0;
};

TokenSchema.methods.setBalance = function(address, newAmount) {
    const idx = this.balances.findIndex(b => b.address === address);
    const value = Decimal128.fromString(newAmount.toString());
    if (idx >= 0) this.balances[idx].amount = value;
    else this.balances.push({ address, amount: value });
};

TokenSchema.methods.toPublic = function() {
    return {
        tokenId: this.tokenId,
        name: this.name,
        symbol: this.symbol,
        totalSupply: this.totalSupply.toString(),
        decimals: this.decimals,
        creator: this.creator,
        txHash: this.txHash,
        logo: this.logo,
        status: this.status,
        holders: this.balances.filter(b => parseFloat(b.amount.toString()) > 0).length,
        createdAt: this.createdAt
    };
};

module.exports = mongoose.model('Token', TokenSchema);
