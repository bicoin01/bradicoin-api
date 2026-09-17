// controllers/tokenController.js
const Token = require('../models/Token');
const WalletModel = require('../models/Wallet');
const { asyncHandler, AppError } = require('../middleware/error');
const crypto = require('crypto');

const MINT_FEE = 0.016;
const PRICE_PER_TOKEN = 1.5;

// ============================================
// POST /api/v1/token/create
// ============================================
exports.create = asyncHandler(async (req, res) => {
    const { name, symbol, supply, logo, description } = req.body;

    if (!name || !symbol || !supply) {
        throw new AppError('name, symbol e supply são obrigatórios', 400);
    }
    if (supply < 1) throw new AppError('Supply deve ser >= 1', 400);
    if (symbol.length > 10) throw new AppError('Símbolo muito longo (máx 10)', 400);
    if (logo && logo.length > 3_000_000) throw new AppError('Logo muito grande', 413);

    const walletDoc = await WalletModel.findOne({ userId: req.user._id });
    if (!walletDoc) throw new AppError('Carteira não encontrada', 404);

    const totalBrd = (supply * PRICE_PER_TOKEN) / 10;
    const totalCost = totalBrd + MINT_FEE;

    const balance = Number(walletDoc.balance || 0);
    if (balance < totalCost) {
        throw new AppError(`Saldo insuficiente. Necessário: ${totalCost.toFixed(8)} BRD`, 402);
    }

    const exists = await Token.findOne({ symbol: symbol.toUpperCase() });
    if (exists) throw new AppError('Símbolo já está em uso', 409);

    walletDoc.balance = (balance - totalCost).toString();
    await walletDoc.save();

    const token = await Token.create({
        ownerId: req.user._id,
        ownerAddress: walletDoc.address,
        name: name.trim(),
        symbol: symbol.toUpperCase().trim(),
        supply,
        logo: logo || null,
        description: description || '',
        listed: true,
        mintFee: MINT_FEE,
        txHash: '0x' + crypto.createHash('sha256')
            .update(`${walletDoc.address}:${symbol}:${Date.now()}`)
            .digest('hex')
    });

    if (req.io) {
        req.io.emit('token:created', {
            symbol: token.symbol,
            name: token.name,
            owner: walletDoc.address,
            timestamp: Date.now()
        });
    }

    res.status(201).json({
        success: true,
        message: 'Token criado com sucesso',
        data: {
            token: token.toPublic(),
            paid: totalCost,
            newBalance: walletDoc.balance.toString()
        }
    });
});

// ============================================
// GET /api/v1/token/my
// ============================================
exports.myTokens = asyncHandler(async (req, res) => {
    const tokens = await Token.find({ ownerId: req.user._id }).sort({ createdAt: -1 });
    res.json({
        success: true,
        data: { tokens: tokens.map((t) => t.toPublic()) }
    });
});

// ============================================
// GET /api/v1/token/marketplace?search=
// ============================================
exports.marketplace = asyncHandler(async (req, res) => {
    const { search } = req.query;
    const filter = { listed: true };

    if (search && typeof search === 'string') {
        filter.$or = [
            { name: { $regex: search, $options: 'i' } },
            { symbol: { $regex: search, $options: 'i' } }
        ];
    }

    const tokens = await Token.find(filter).sort({ createdAt: -1 }).limit(100);

    res.json({
        success: true,
        data: {
            tokens: tokens.map((t) => t.toPublic()),
            count: tokens.length
        }
    });
});

// ============================================
// DELETE /api/v1/token/:id
// ============================================
exports.remove = asyncHandler(async (req, res) => {
    const token = await Token.findOne({
        _id: req.params.id,
        ownerId: req.user._id
    });

    if (!token) throw new AppError('Token não encontrado', 404);

    await token.deleteOne();

    res.json({
        success: true,
        message: 'Token deletado com sucesso'
    });
});
