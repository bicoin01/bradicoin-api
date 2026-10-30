// controllers/airdropController.js
// ============================================
// Airdrop Controller - BradiChain
// ============================================
// Includes global pool control per campaign.
// Claim flow:
//   1. Basic validations (address, auth, enabled, already claimed, cooldown)
//   2. Check pool balance
//   3. tryDebit on pool (atomic) - if fails, 410 Gone
//   4. Create Airdrop as 'processing'
//   5. Credit via transactions.creditAirdrop
//   6. If credit fails -> refund pool + 'failed'
//   7. If credit succeeds -> 'completed'
// ============================================

const Airdrop = require('../models/Airdrop');
const AirdropPool = require('../models/AirdropPool');
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

    // 1. Basic validations
    if (!address) {
        throw new AppError('Wallet address is required', 400);
    }

    if (!wallet.isValidAddress(address)) {
        throw new AppError('Invalid address', 400);
    }

    const walletAddress = address.toLowerCase();

    // 2. Verify wallet belongs to logged-in user
    if (req.user.walletAddress !== walletAddress) {
        throw new AppError('This wallet does not belong to your account', 403);
    }

    // 3. Airdrop enabled via env?
    if (process.env.AIRDROP_ENABLED === 'false') {
        throw new AppError('Airdrop temporarily disabled', 503);
    }

    // 4. Already claimed?
    const existing = await Airdrop.findOne({ userId: req.user._id, campaign: CAMPAIGN });

    if (existing && existing.status === 'completed') {
        return res.status(409).json({
            success: false,
            error: 'You have already claimed this airdrop',
            data: {
                amount: existing.amount,
                txHash: existing.txHash,
                claimedAt: existing.claimedAt
            }
        });
    }

    // 5. Cooldown (24h)
    if (existing && existing.claimedAt) {
        const elapsedHours = (Date.now() - existing.claimedAt.getTime()) / 36e5;
        if (elapsedHours < COOLDOWN_H) {
            throw new AppError(
                `Wait ${Math.ceil(COOLDOWN_H - elapsedHours)}h before claiming again`,
                429
            );
        }
    }

    // 6. Check pool balance
    const pool = await AirdropPool.findByCampaign(CAMPAIGN);

    if (!pool) {
        // First claim ever and pool doesn't exist yet.
        // Create it with initial balance from env (or 0).
        const initial = Number(process.env.AIRDROP_INITIAL_POOL || 0);
        if (initial < AMOUNT) {
            throw new AppError(
                'Airdrop is not configured yet. Contact the administrator.',
                503
            );
        }
        await AirdropPool.ensure(CAMPAIGN, initial);
    } else {
        if (!pool.enabled) {
            throw new AppError('Airdrop temporarily disabled', 503);
        }
        if (pool.remaining() < AMOUNT) {
            return res.status(410).json({
                success: false,
                error: 'Airdrop exhausted',
                data: {
                    remaining: pool.remaining(),
                    needed: AMOUNT
                }
            });
        }
    }

    // 7. Debit pool ATOMICALLY (prevents race conditions)
    //    If two users click at the same time, only one debit succeeds.
    const debited = await AirdropPool.tryDebit(CAMPAIGN, AMOUNT);

    if (!debited) {
        // Someone consumed the pool between the check (step 6) and tryDebit.
        return res.status(410).json({
            success: false,
            error: 'Airdrop exhausted',
            data: { remaining: 0, needed: AMOUNT }
        });
    }

    // 8. Create/update record as processing
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

    // 9. Credit via internal system
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

        // Return fresh balance
        const freshWallet = await WalletModel.findOne({ address: walletAddress });
        const freshPool = await AirdropPool.findByCampaign(CAMPAIGN);

        res.json({
            success: true,
            message: 'Airdrop sent successfully!',
            data: {
                amount: AMOUNT,
                txHash: result.txHash,
                newBalance: freshWallet ? freshWallet.balance.toString() : undefined,
                poolRemaining: freshPool ? freshPool.remaining() : null
            }
        });
    } catch (err) {
        // 10. Credit failed: REFUND the pool
        try {
            await AirdropPool.refund(CAMPAIGN, AMOUNT);
        } catch (refundErr) {
            // Emergency log - pool will be inconsistent until manual repair
            console.error(
                `🚨 EMERGENCY: refund failed for ${walletAddress}. ` +
                `amount=${AMOUNT}, campaign=${CAMPAIGN}, err=${refundErr.message}`
            );
        }

        airdrop.status = 'failed';
        airdrop.error = err.message;
        await airdrop.save();

        throw new AppError(`Failed to send airdrop: ${err.message}`, 500);
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

    const pool = await AirdropPool.findByCampaign(CAMPAIGN);
    const remainingPool = pool ? pool.remaining() : null;
    const poolEnabled = pool ? pool.enabled : true;

    if (!existing) {
        return res.json({
            success: true,
            data: {
                available: remainingPool === null ? true : remainingPool >= AMOUNT,
                alreadyClaimed: false,
                amount: AMOUNT,
                nextClaimAt: null,
                remainingPool,
                poolEnabled
            }
        });
    }

    const nextClaimAt = existing.claimedAt
        ? new Date(existing.claimedAt.getTime() + COOLDOWN_H * 36e5)
        : null;

    res.json({
        success: true,
        data: {
            available:
                existing.status !== 'completed' &&
                poolEnabled &&
                (remainingPool === null || remainingPool >= AMOUNT),
            alreadyClaimed: existing.status === 'completed',
            amount: existing.amount,
            status: existing.status,
            txHash: existing.txHash,
            claimedAt: existing.claimedAt,
            nextClaimAt,
            remainingPool,
            poolEnabled
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

    const pool = await AirdropPool.findByCampaign(CAMPAIGN);

    res.json({
        success: true,
        data: {
            totalClaims,
            totalDistributed: agg[0]?.total || 0,
            campaign: CAMPAIGN,
            amountPerClaim: AMOUNT,
            pool: pool
                ? {
                      totalDeposited: pool.totalDeposited,
                      totalDistributed: pool.totalDistributed,
                      remaining: pool.remaining(),
                      enabled: pool.enabled,
                      lastDepositAt: pool.lastDepositAt,
                      lastDistributedAt: pool.lastDistributedAt
                  }
                : null
        }
    });
});
