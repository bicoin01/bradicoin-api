// routes/nft.js
const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');

const nftController = require('../controllers/nftController');
const { authenticate } = require('../middleware/auth');

const createLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 20,
    keyGenerator: (req) => req.user?._id?.toString() || req.ip,
    message: { success: false, error: 'Muitos NFTs criados. Tente novamente em 1 hora.' }
});

const queryLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    message: { success: false, error: 'Muitas consultas.' }
});

router.post('/create', authenticate, createLimiter, nftController.create);
router.get('/my', authenticate, queryLimiter, nftController.myNFTs);
router.get('/:id', queryLimiter, nftController.getById);
router.post('/:id/send', authenticate, nftController.send);
router.delete('/:id', authenticate, nftController.remove);

module.exports = router;
