// controllers/airdropController.js
// ============================================
// Controller de Airdrop - BradiChain
// ============================================

const Airdrop = require('../models/Airdrop');
const WalletModel = require('../models/Wallet');
const transactions = require('../transactions');
const wallet = require('../wallet');
const { asyncHandler, AppError } = require('../middleware/error');

const CAMPAIGN = 'bradicoin-genesis';
const AMOUNT = Number(process.env.AIRDROP_AMOUNT || 50);
const COOLDOWN_H = Number(process.env.AIRDROP_COOLDOWN_HOURS || 24);

// ============================================
// POST /api/v1/airdrop/claim
// ============================================
exports.claim = asyncHandler(async (req, res) => {
    const { address } = req.body;

    // 1. Validações
    if (!address) {
        throw new AppError('Endereço da carteira é obrigatório', 400);
    }

    if (!wallet.isValidAddress(address)) {
        throw new AppError('Endereço inválido', 400);
    }

    const walletAddress = address.toLowerCase();

    // 2. Verifica que a carteira pertence ao usuário logado
    if (req.user.walletAddress !== walletAddress) {
        throw new AppError('Esta carteira não pertence à sua conta', 403);
    }

    // 3. Airdrop habilitado?
    if (process.env.AIRDROP_ENABLED === 'false') {
        throw new AppError('Airdrop temporariamente desabilitado', 503);
    }

    // 4. Já resgatou?
    const existing = await Airdrop.findOne({ userId: req.user._id, campaign: CAMPAIGN });

    if (existing && existing.status === 'completed') {
        return res.status(409).json({
            success: false,
            error: 'Você já resgatou este airdrop',
            data: {
                amount: existing.amount,
                txHash: existing.txHash,
                claimedAt: existing.claimedAt
            }
        });
    }

    // 5. Cooldown
    if (existing && existing.claimedAt) {
        const elapsedHours = (Date.now() - existing.claimedAt.getTime()) / 36e5;
        if (elapsedHours < COOLDOWN_H) {
            throw new AppError(
                `Aguarde ${Math.ceil(COOLDOWN_H - elapsedHours)}h para novo resgate`,
                429
            );
        }
    }

    // 6. Cria/atualiza registro como processing
    const airdrop = existing || new Airdrop({
        userId: req.user._id,
        walletAddress,
        amount: AMOUNT,
        campaign: CAMPAIGN
    });

    airdrop.status = 'processing';
    airdrop.error = null;
    airdrop.ip = req.ip;
    await airdrop.save();

    // 7. Credita via sistema interno (não on-chain EVM)
    //    Se vocês já têm uma função de mint/transfer interno, use ela aqui.
    try {
        const result = await transactions.creditAirdrop({
            toAddress: walletAddress,
            amount: AMOUNT,
            campaign: CAMPAIGN,
            userId: req.user._id
        });

        airdrop.status = 'completed';
        airdrop.txHash = result.txHash;
        airdrop.blockIndex = result.blockIndex || null;
        airdrop.claimedAt = new Date();
        await airdrop.save();

        // Atualiza saldo retornado
        const freshWallet = await WalletModel.findOne({ address: walletAddress });

        res.json({
            success: true,
            message: 'Airdrop enviado com sucesso!',
            data: {
                amount: AMOUNT,
                txHash: result.txHash,
                newBalance: freshWallet ? freshWallet.balance.toString() : undefined
            }
        });
    } catch (err) {
        airdrop.status = 'failed';
        airdrop.error = err.message;
        await airdrop.save();

        throw new AppError(`Falha ao enviar airdrop: ${err.message}`, 500);
    }
});

// ============================================
// GET /api/v1/airdrop/info
// ============================================
exports.info = asyncHandler(async (req, res) => {
    const existing = await Airdrop.findOne({
        userId: req.user._id,
        campaign: CAMPAIGN
    });

    if (!existing) {
        return res.json({
            success: true,
            data: {
                available: true,
                alreadyClaimed: false,
                amount: AMOUNT,
                nextClaimAt: null
            }
        });
    }

    const nextClaimAt = existing.claimedAt
        ? new Date(existing.claimedAt.getTime() + COOLDOWN_H * 36e5)
        : null;

    res.json({
        success: true,
        data: {
            available: existing.status !== 'completed',
            alreadyClaimed: existing.status === 'completed',
            amount: existing.amount,
            status: existing.status,
            txHash: existing.txHash,
            claimedAt: existing.claimedAt,
            nextClaimAt
        }
    });
});

// ============================================
// GET /api/v1/airdrop/stats
// ============================================
exports.stats = asyncHandler(async (req, res) => {
    const totalClaims = await Airdrop.countDocuments({
        campaign: CAMPAIGN,
        status: 'completed'
    });

    const agg = await Airdrop.aggregate([
        { $match: { campaign: CAMPAIGN, status: 'completed' } },
        { $group: { _id: null, total: { $sum: '$amount' } } }
    ]);

    res.json({
        success: true,
        data: {
            totalClaims,
            totalDistributed: agg[0]?.total || 0,
            campaign: CAMPAIGN,
            amountPerClaim: AMOUNT
        }
    });
});
