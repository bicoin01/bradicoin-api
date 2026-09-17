// controllers/nftController.js
const NFT = require('../models/NFT');
const WalletModel = require('../models/Wallet');
const { asyncHandler, AppError } = require('../middleware/error');
const crypto = require('crypto');

const MINT_FEE = 0.005;
const SEND_FEE = 0.02;

// ============================================
// POST /api/v1/nft/create
// ============================================
exports.create = asyncHandler(async (req, res) => {
    const { title, description, price, image } = req.body;

    if (!title || !image) throw new AppError('title e image são obrigatórios', 400);
    if (typeof image !== 'string' || image.length < 100) {
        throw new AppError('Imagem inválida (envie dataURL base64)', 400);
    }
    if (image.length > 3_000_000) throw new AppError('Imagem muito grande (máx ~2MB)', 413);

    const nftPrice = Number(price) || 0;
    const walletDoc = await WalletModel.findOne({ userId: req.user._id });
    if (!walletDoc) throw new AppError('Carteira não encontrada', 404);

    const total = nftPrice + MINT_FEE;
    const balance = Number(walletDoc.balance || 0);
    if (balance < total) {
        throw new AppError(`Saldo insuficiente. Necessário: ${total.toFixed(8)} BRD`, 402);
    }

    walletDoc.balance = (balance - total).toString();
    await walletDoc.save();

    const tokenId = 'nft_' + crypto.randomBytes(8).toString('hex');

    const nft = await NFT.create({
        ownerId: req.user._id,
        ownerAddress: walletDoc.address,
        creatorAddress: walletDoc.address,
        title: title.trim(),
        description: description || '',
        image,
        price: nftPrice,
        tokenId,
        mintFee: MINT_FEE,
        txHash: '0x' + crypto.createHash('sha256')
            .update(`${walletDoc.address}:${tokenId}:${Date.now()}`)
            .digest('hex'),
        history: [{ from: null, to: walletDoc.address, price: nftPrice }]
    });

    if (req.io) {
        req.io.emit('nft:minted', {
            tokenId: nft.tokenId,
            title: nft.title,
            owner: walletDoc.address,
            timestamp: Date.now()
        });
    }

    res.status(201).json({
        success: true,
        message: 'NFT criado com sucesso',
        data: {
            nft: nft.toPublic(),
            paid: total,
            newBalance: walletDoc.balance.toString()
        }
    });
});

// ============================================
// GET /api/v1/nft/my
// ============================================
exports.myNFTs = asyncHandler(async (req, res) => {
    const nfts = await NFT.find({ ownerId: req.user._id }).sort({ createdAt: -1 });
    res.json({
        success: true,
        data: { nfts: nfts.map((n) => n.toPublic()) }
    });
});

// ============================================
// GET /api/v1/nft/:id
// ============================================
exports.getById = asyncHandler(async (req, res) => {
    const nft = await NFT.findById(req.params.id);
    if (!nft) throw new AppError('NFT não encontrado', 404);
    res.json({ success: true, data: { nft: nft.toPublic() } });
});

// ============================================
// POST /api/v1/nft/:id/send
// ============================================
exports.send = asyncHandler(async (req, res) => {
    const { to } = req.body;
    if (!to) throw new AppError('Destinatário é obrigatório', 400);
    if (!require('../wallet').isValidAddress(to)) {
        throw new AppError('Endereço de destino inválido', 400);
    }
    const toAddr = to.toLowerCase();

    const nft = await NFT.findOne({ _id: req.params.id, ownerId: req.user._id });
    if (!nft) throw new AppError('NFT não encontrado ou você não é o dono', 404);

    const walletDoc = await WalletModel.findOne({ userId: req.user._id });
    const balance = Number(walletDoc.balance || 0);
    if (balance < SEND_FEE) {
        throw new AppError('Saldo insuficiente para a taxa de envio', 402);
    }

    const destWallet = await WalletModel.findOne({ address: toAddr });
    if (!destWallet) throw new AppError('Carteira de destino não encontrada', 404);

    walletDoc.balance = (balance - SEND_FEE).toString();
    await walletDoc.save();

    nft.history.push({ from: nft.ownerAddress, to: toAddr, price: 0 });
    nft.ownerId = destWallet.userId;
    nft.ownerAddress = toAddr;
    nft.txHash = '0x' + crypto.createHash('sha256')
        .update(`${nft.tokenId}:${toAddr}:${Date.now()}`)
        .digest('hex');
    await nft.save();

    res.json({
        success: true,
        message: 'NFT enviado com sucesso',
        data: {
            tokenId: nft.tokenId,
            to: toAddr,
            txHash: nft.txHash,
            newBalance: walletDoc.balance.toString()
        }
    });
});

// ============================================
// DELETE /api/v1/nft/:id
// ============================================
exports.remove = asyncHandler(async (req, res) => {
    const nft = await NFT.findOne({ _id: req.params.id, ownerId: req.user._id });
    if (!nft) throw new AppError('NFT não encontrado', 404);
    await nft.deleteOne();
    res.json({ success: true, message: 'NFT deletado com sucesso' });
});
