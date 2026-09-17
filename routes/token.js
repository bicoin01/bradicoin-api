// routes/token.js
const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');

const tokenController = require('../controllers/tokenController');
const { authenticate } = require('../middleware/auth');

const createLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1h
    max: 10,
    keyGenerator: (req) => req.user?._id?.toString() || req.ip,
    message: { success: false, error: 'Muitos tokens criados. Tente novamente em 1 hora.' }
});

const queryLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    message: { success: false, error: 'Muitas consultas.' }
});

router.post('/create', authenticate, createLimiter, tokenController.create);
router.get('/my', authenticate, queryLimiter, tokenController.myTokens);
router.get('/marketplace', queryLimiter, tokenController.marketplace);
router.delete('/:id', authenticate, tokenController.remove);

// ⚠️ Exporta padrão antigo (sem { router }) — wallet.js e transaction.js usam esse
module.exports = router;
