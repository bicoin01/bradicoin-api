// models/NFT.js
const mongoose = require('mongoose');

const NFTSchema = new mongoose.Schema(
    {
        ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
        ownerAddress: { type: String, required: true, lowercase: true, index: true },
        creatorAddress: { type: String, required: true, lowercase: true, index: true },
        title: { type: String, required: true, trim: true, maxlength: 100 },
        description: { type: String, default: '', maxlength: 1000 },
        image: { type: String, required: true },
        price: { type: Number, required: true, min: 0 },
        tokenId: { type: String, unique: true, index: true },
        txHash: { type: String, default: null },
        mintFee: { type: Number, default: 0.005 },
        forSale: { type: Boolean, default: false },
        history: [{
            from: String,
            to: String,
            price: Number,
            at: { type: Date, default: Date.now }
        }]
    },
    { timestamps: true }
);

NFTSchema.methods.toPublic = function () {
    return {
        id: this._id,
        tokenId: this.tokenId,
        title: this.title,
        description: this.description,
        image: this.image,
        price: this.price,
        forSale: this.forSale,
        ownerAddress: this.ownerAddress,
        creatorAddress: this.creatorAddress,
        txHash: this.txHash,
        history: this.history,
        createdAt: this.createdAt
    };
};

module.exports = mongoose.model('NFT', NFTSchema);
