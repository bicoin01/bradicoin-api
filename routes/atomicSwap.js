// routes/atomicSwap.js
const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/swapController');

// Info
router.get('/chains', ctrl.listChains);
router.get('/config', ctrl.getConfig);
router.get('/stats', ctrl.getStats);

// Secret utilities
router.post('/secret/generate', ctrl.generateSecret);
router.post('/secret/hash', ctrl.hashSecret);
router.post('/secret/verify', ctrl.verifySecret);

// HTLC nativo Bradicoin
router.post('/htlc/lock', ctrl.lockHtlc);
router.post('/htlc/claim', ctrl.claimHtlc);
router.post('/htlc/refund', ctrl.refundHtlc);
router.get('/htlc', ctrl.listHtlcs);
router.get('/htlc/:htlcId', ctrl.getHtlc);

// Swap Engine — orquestração
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

module.exports = router;
