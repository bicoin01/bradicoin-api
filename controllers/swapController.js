// controllers/swapController.js
const htlc = require('../atomic-swap/engine/htlc');
const { listChains } = require('../atomic-swap');

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
            chains: listChains().length
        }
    });
};

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

exports.generateSecret = (req, res) => {
    try {
        const secret = htlc.generateSecret();
        const hashlock = htlc.hashSecret(secret);
        res.json({ success: true, secret, hashlock });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
};

exports.hashSecret = (req, res) => {
    try {
        const { secret } = req.body;
        if (!secret) throw new Error('secret obrigatório');
        res.json({ success: true, hashlock: htlc.hashSecret(secret) });
    } catch (e) {
        res.status(400).json({ success: false, error: e.message });
    }
};
