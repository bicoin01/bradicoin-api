// controllers/swapController.js
const htlc = require('../atomic-swap/engine/htlc');
const swapEngine = require('../atomic-swap/engine/swapEngine');
const secretManager = require('../atomic-swap/security/secretManager');
const { listChains, getAdapter } = require('../atomic-swap');

// ============================================
// CHAINS / CONFIG
// ============================================
exports.listChains = (req, res) => {
    try {
        res.json({ success: true, chains: listChains() });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
};

exports.getConfig = (req, res) => {
    res.json({
        success: true,
        config: {
            htlc: htlc.CONFIG,
            swapEngine: swapEngine.CONFIG,
            chains: listChains().length
        }
    });
};

// ============================================
// HTLC (operacões diretas na Bradicoin)
// ============================================
exports.lockHtlc = async (req, res) => {
    try {
        const { sender, receiver, amount, hashlock, timelock, swapId } = req.body;
        const result = await htlc.lock({ sender, receiver, amount, hashlock, timelock, swapId });
        res.json({ success: true, htlc: result });
    } catch (e) {
        res.status(400).json({ success: false, error: e.message });
    }
};

exports.claimHtlc = async (req, res) => {
    try {
        const { htlcId, preimage, claimer } = req.body;
        const result = await htlc.claim({ htlcId, preimage, claimer });
        res.json({ success: true, htlc: result });
    } catch (e) {
        res.status(400).json({ success: false, error: e.message });
    }
};

exports.refundHtlc = async (req, res) => {
    try {
        const { htlcId, refunder } = req.body;
        const result = await htlc.refund({ htlcId, refunder });
        res.json({ success: true, htlc: result });
    } catch (e) {
        res.status(400).json({ success: false, error: e.message });
    }
};

exports.getHtlc = async (req, res) => {
    try {
        const result = await htlc.getHtlc(req.params.htlcId);
        res.json({ success: true, htlc: result });
    } catch (e) {
        res.status(404).json({ success: false, error: e.message });
    }
};

exports.listHtlcs = async (req, res) => {
    try {
        const { address, status, chain, limit, offset } = req.query;
        const result = await htlc.listHtlcs({
            address, status, chain,
            limit: limit ? parseInt(limit) : 50,
            offset: offset ? parseInt(offset) : 0
        });
        res.json({ success: true, ...result });
    } catch (e) {
        res.status(400).json({ success: false, error: e.message });
    }
};

// ============================================
// SECRET
// ============================================
exports.generateSecret = (req, res) => {
    try {
        const secret = secretManager.generateSecret();
        const hashlock = secretManager.hashSecret(secret);
        res.json({ success: true, secret, hashlock });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
};

exports.hashSecret = (req, res) => {
    try {
        const { secret } = req.body;
        if (!secret) throw new Error('secret obrigatório');
        res.json({ success: true, hashlock: secretManager.hashSecret(secret) });
    } catch (e) {
        res.status(400).json({ success: false, error: e.message });
    }
};

exports.verifySecret = (req, res) => {
    try {
        const { secret, hashlock } = req.body;
        const ok = secretManager.verifySecret(secret, hashlock);
        res.json({ success: true, valid: ok });
    } catch (e) {
        res.status(400).json({ success: false, error: e.message });
    }
};

// ============================================
// SWAP ENGINE — Orquestração cross-chain
// ============================================

exports.createOrder = async (req, res) => {
    try {
        const result = await swapEngine.createOrder(req.body);
        res.json({
            success: true,
            // ⚠️ SEGREDO SÓ É RETORNADO UMA VEZ
            warning: 'GUARDE O SECRET! Ele só é retornado agora.',
            ...result
        });
    } catch (e) {
        res.status(400).json({ success: false, error: e.message });
    }
};

exports.acceptOrder = async (req, res) => {
    try {
        const { swapId, takerAddress } = req.body;
        const result = await swapEngine.acceptOrder({ swapId, takerAddress });
        res.json({ success: true, order: result });
    } catch (e) {
        res.status(400).json({ success: false, error: e.message });
    }
};

exports.makerLock = async (req, res) => {
    try {
        const { swapId, makerAddress } = req.body;
        const result = await swapEngine.makerLock({ swapId, makerAddress });
        res.json({ success: true, ...result });
    } catch (e) {
        res.status(400).json({ success: false, error: e.message });
    }
};

exports.takerLock = async (req, res) => {
    try {
        const { swapId, takerAddress } = req.body;
        const result = await swapEngine.takerLock({ swapId, takerAddress });
        res.json({ success: true, ...result });
    } catch (e) {
        res.status(400).json({ success: false, error: e.message });
    }
};

exports.revealPreimage = async (req, res) => {
    try {
        const { swapId, makerAddress, secret } = req.body;
        const result = await swapEngine.revealPreimage({ swapId, makerAddress, secret });
        res.json({ success: true, ...result });
    } catch (e) {
        res.status(400).json({ success: false, error: e.message });
    }
};

exports.takerClaim = async (req, res) => {
    try {
        const { swapId, takerAddress } = req.body;
        const result = await swapEngine.takerClaim({ swapId, takerAddress });
        res.json({ success: true, ...result });
    } catch (e) {
        res.status(400).json({ success: false, error: e.message });
    }
};

exports.refundOrder = async (req, res) => {
    try {
        const { swapId, caller } = req.body;
        const result = await swapEngine.refund({ swapId, caller });
        res.json({ success: true, ...result });
    } catch (e) {
        res.status(400).json({ success: false, error: e.message });
    }
};

exports.cancelOrder = async (req, res) => {
    try {
        const { swapId, makerAddress } = req.body;
        const result = await swapEngine.cancelOrder({ swapId, makerAddress });
        res.json({ success: true, order: result });
    } catch (e) {
        res.status(400).json({ success: false, error: e.message });
    }
};

exports.getOrder = async (req, res) => {
    try {
        const result = await swapEngine.getOrder(req.params.swapId);
        res.json({ success: true, order: result });
    } catch (e) {
        res.status(404).json({ success: false, error: e.message });
    }
};

exports.listOrders = async (req, res) => {
    try {
        const { status, fromChain, toChain, address, limit, offset } = req.query;
        const result = await swapEngine.listOrders({
            status, fromChain, toChain, address,
            limit: limit ? parseInt(limit) : 50,
            offset: offset ? parseInt(offset) : 0
        });
        res.json({ success: true, ...result });
    } catch (e) {
        res.status(400).json({ success: false, error: e.message });
    }
};

exports.getHistory = async (req, res) => {
    try {
        const { address, limit, offset } = req.query;
        if (!address) throw new Error('address obrigatório');
        const result = await swapEngine.getHistory(
            address,
            limit ? parseInt(limit) : 50,
            offset ? parseInt(offset) : 0
        );
        res.json({ success: true, ...result });
    } catch (e) {
        res.status(400).json({ success: false, error: e.message });
    }
};

exports.getStats = async (req, res) => {
    try {
        const stats = await swapEngine.getStats();
        res.json({ success: true, stats });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
};
