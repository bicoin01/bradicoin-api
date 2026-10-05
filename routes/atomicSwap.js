// routes/atomicSwap.js
const express = require('express');
const router = express.Router();
const swapController = require('../controllers/swapController');

// Info
router.get('/chains', swapController.listChains);
router.get('/config', swapController.getConfig);

// HTLC nativo Bradicoin
router.post('/htlc/lock', swapController.lockHtlc);
router.post('/htlc/claim', swapController.claimHtlc);
router.post('/htlc/refund', swapController.refundHtlc);
router.get('/htlc/:htlcId', swapController.getHtlc);
router.get('/htlc', swapController.listHtlcs);

// Utilities
router.post('/secret/generate', swapController.generateSecret);
router.post('/secret/hash', swapController.hashSecret);

module.exports = router;
