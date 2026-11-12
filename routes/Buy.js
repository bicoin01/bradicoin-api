// ============================================
// GET /api/v1/buy/treasury — status da tesouraria
// ============================================
router.get('/treasury', async (req, res) => {
    try {
        const Treasury = require('../models/Treasury');
        const WalletModel = require('../models/Wallet');

        const treasury = await Treasury.getMain();

        const agg = await WalletModel.aggregate([
            { $match: { status: 'active' } },
            { $group: { _id: null, total: { $sum: { $toDouble: '$balance' } } } }
        ]);

        const balanceBrd = parseFloat(treasury.balance.toString());
        const initialBrd = parseFloat(treasury.initialBalance.toString());

        res.json({
            success: true,
            data: {
                balanceBrd: treasury.balance.toString(),
                balanceUsd: (balanceBrd * 10).toFixed(2),
                initialBrd: treasury.initialBalance.toString(),
                initialUsd: (initialBrd * 10).toFixed(2),
                totalSoldBrd: treasury.totalSold.toString(),
                totalCreditedBrd: treasury.totalCredited.toString(),
                lowBalanceAlertAt: treasury.lowBalanceAlertAt,
                networkTotalSupply: (agg[0]?.total || 0).toFixed(8),
                brdPriceUsd: 10
            }
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});
