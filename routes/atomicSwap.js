// routes/atomicSwap.js
// ============================================
// Atomic Swap — Rotas REST
// ============================================
// HTLC nativo + SwapEngine + Order Book P2P
// ============================================

const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/swapController');

// ============================================
// INFO / CONFIG
// ============================================
router.get('/chains', ctrl.listChains);
router.get('/config', ctrl.getConfig);
router.get('/stats', ctrl.getStats);

// ============================================
// SECRET — Geração/validação de preimage
// ============================================
router.post('/secret/generate', ctrl.generateSecret);
router.post('/secret/hash', ctrl.hashSecret);
router.post('/secret/verify', ctrl.verifySecret);

// ============================================
// HTLC — Nativo Bradicoin
// ============================================
router.post('/htlc/lock', ctrl.lockHtlc);
router.post('/htlc/claim', ctrl.claimHtlc);
router.post('/htlc/refund', ctrl.refundHtlc);
router.get('/htlc', ctrl.listHtlcs);
router.get('/htlc/:htlcId', ctrl.getHtlc);

// ============================================
// SWAP ENGINE — Orquestração cross-chain
// ============================================
router.post('/order', ctrl.createOrder);
router.post('/order/accept', ctrl.acceptOrder);
router.post('/order/maker-lock', ctrl.makerLock);
router.post('/order/taker-lock', ctrl.takerLock);
router.post('/order/reveal', ctrl.revealPreimage);
router.post('/order/taker-claim', ctrl.takerClaim);
router.post('/order/refund', ctrl.refundOrder);
router.post('/order/cancel', ctrl.cancelOrder);

router.get('/order', ctrl.listOrders);
router.get('/order/:swapId', ctrl.getOrder);

router.get('/history', ctrl.getHistory);

// ============================================
// ORDER BOOK P2P
// ============================================
router.get('/orderbook/pairs', ctrl.getOrderBookPairs);
router.get('/orderbook/stats', ctrl.getOrderBookStats);
router.get('/orderbook/orders', ctrl.listOrderBookOrders);
router.post('/orderbook/search', ctrl.searchOrderBook);

// ============================================
// GOSSIP — Estatísticas da camada P2P
// ============================================
router.get('/gossip/stats', ctrl.getGossipStats);

// ============================================
// MATCHER — Busca de ordens compatíveis
// ============================================
router.post('/match/find', ctrl.findMatches);
router.post('/match/top-pairs', ctrl.getTopPairs);

// ============================================
// PUBLISH — Criar + anunciar via gossip
// ============================================
router.post('/order/publish', ctrl.publishOrder);

module.exports = router;
