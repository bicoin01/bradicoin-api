// routes/buy.js
// ============================================
// Rotas de compra de BradiCoin
// Monta em: /api/v1/buy
// ============================================

const express = require('express');
const router = express.Router();

const buyController = require('../controllers/buy');

// ⚠️ Ajuste o caminho/nome do middleware de auth se for diferente
let requireAuth;
try {
    const authMod = require('../middleware/auth');
    requireAuth = authMod.requireAuth
              || authMod.authenticate
              || authMod.verifyToken
              || authMod.protect
              || authMod;
} catch (e) {
    console.warn('[routes/buy] middleware/auth não encontrado — usando stub (NÃO USE EM PRODUÇÃO)');
    requireAuth = (req, res, next) => {
        req.user = { id: 'stub-user-id' }; // ⚠️ stub pra testar
        next();
    };
}

// ============================================
// ROTAS
// ============================================

// POST /api/v1/buy/create  → cria pedido
router.post('/create', requireAuth, buyController.createOrder);

// GET /api/v1/buy/me       → lista pedidos do usuário logado
router.get('/me', requireAuth, buyController.myOrders);

// GET /api/v1/buy/:orderId → status do pedido
router.get('/:orderId', requireAuth, buyController.getOrder);

module.exports = router;
