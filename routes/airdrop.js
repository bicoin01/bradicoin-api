// routes/airdrop.js
// ============================================
// Rotas de Airdrop - BradiChain
// ============================================
// Exporta { router } porque o server.js faz:
//   const { router: airdropRouter } = require('./routes/airdrop');
// ============================================

const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');

const airdropController = require('../controllers/airdropController');
const { authenticate } = require('../middleware/auth');

// ============================================
// RATE LIMITERS
// ============================================

const claimLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1h
    max: 5,
    keyGenerator: (req) => req.user?._id?.toString() || req.ip,
    message: { success: false, error: 'Muitas tentativas de resgate. Tente novamente em 1 hora.' },
    standardHeaders: true,
    legacyHeaders: false
});

const queryLimiter = rateLimit({
    windowMs: 60 * 1000, // 1min
    max: 60,
    message: { success: false, error: 'Muitas consultas. Aguarde um instante.' }
});

// ============================================
// ROTAS
// ============================================

router.get('/info', authenticate, queryLimiter, airdropController.info);
router.post('/claim', authenticate, claimLimiter, airdropController.claim);
router.get('/stats', queryLimiter, airdropController.stats); // público

// ============================================
// EXPORTS — ⚠️ padrão { router }
// ============================================
module.exports = { router };
