// developer-api.js
// Bradicoin Developer API - Complete SDK for third-party integrations
// Allows developers to integrate BRD payments, wallets, and transactions

const express = require('express');
const crypto = require('crypto');
const Blockchain = require('./blockchain');
const Wallet = require('./wallet');
const PublicTransactions = require('./transactions');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ==================== CONFIGURATION ====================
const CONFIG = {
    API_PORT: 3001,
    API_KEY_HEADER: 'X-API-Key',
    API_SECRET_HEADER: 'X-API-Secret',
    WEBHOOK_TIMEOUT: 5000,
    TRANSACTION_EXPIRY: 3600000, // 1 hour
    MINIMUM_PAYMENT: 0.01,
    MAXIMUM_PAYMENT: 1000000
};

// Store for developer apps
const developerApps = new Map(); // apiKey -> { name, secret, webhookUrl, createdAt, totalRequests }
const paymentLinks = new Map(); // paymentId -> { amount, toAddress, status, callbackUrl, expiresAt, txHash }
const webhookLogs = []; // Log all webhook deliveries

// Initialize core modules
const blockchain = new Blockchain();
const wallet = new Wallet();
const transactions = new PublicTransactions(blockchain);

// ==================== HELPER FUNCTIONS ====================

function generateApiKey() {
    return 'brd_live_' + crypto.randomBytes(24).toString('hex');
}

function generateApiSecret() {
    return crypto.randomBytes(32).toString('hex');
}

function generatePaymentId() {
    return 'pay_' + crypto.randomBytes(16).toString('hex');
}

function validateAddress(address) {
    return address && (address.startsWith('BRD-') || address.match(/^0x[a-fA-F0-9]{40}$/)) && address.length > 10;
}

async function sendWebhook(webhookUrl, event, data) {
    if (!webhookUrl) return null;
    
    const payload = {
        event: event,
        timestamp: new Date().toISOString(),
        data: data
    };
    
    const startTime = Date.now();
    let success = false;
    let responseStatus = null;
    
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), CONFIG.WEBHOOK_TIMEOUT);
        
        const response = await fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal: controller.signal
        });
        
        clearTimeout(timeoutId);
        responseStatus = response.status;
        success = response.ok;
    } catch (error) {
        responseStatus = error.name === 'AbortError' ? 408 : 500;
    }
    
    // Log webhook attempt
    webhookLogs.unshift({
        event: event,
        webhookUrl: webhookUrl,
        success: success,
        statusCode: responseStatus,
        duration: Date.now() - startTime,
        timestamp: new Date().toISOString()
    });
    
    // Keep only last 1000 logs
    if (webhookLogs.length > 1000) webhookLogs.pop();
    
    return { success, statusCode: responseStatus };
}

// ==================== DEVELOPER API ENDPOINTS ====================

// 1. Register new developer app
app.post('/api/developer/register', async (req, res) => {
    try {
        const { appName, webhookUrl, email } = req.body;
        
        if (!appName) {
            return res.status(400).json({ error: 'appName is required' });
        }
        
        const apiKey = generateApiKey();
        const apiSecret = generateApiSecret();
        
        developerApps.set(apiKey, {
            name: appName,
            secret: apiSecret,
            webhookUrl: webhookUrl || null,
            email: email || null,
            createdAt: new Date().toISOString(),
            totalRequests: 0,
            balance: 0 // For developers who hold BRD
        });
        
        res.json({
            success: true,
            apiKey: apiKey,
            apiSecret: apiSecret,
            appName: appName,
            message: '✅ Developer app registered successfully! Store your API Secret safely.'
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 2. Authentication middleware
function authenticate(req, res, next) {
    const apiKey = req.headers[CONFIG.API_KEY_HEADER.toLowerCase()];
    const apiSecret = req.headers[CONFIG.API_SECRET_HEADER.toLowerCase()];
    
    if (!apiKey || !apiSecret) {
        return res.status(401).json({ error: 'API Key and Secret are required' });
    }
    
    const app = developerApps.get(apiKey);
    if (!app || app.secret !== apiSecret) {
        return res.status(401).json({ error: 'Invalid API credentials' });
    }
    
    // Update request count
    app.totalRequests++;
    developerApps.set(apiKey, app);
    
    req.developerApp = app;
    req.apiKey = apiKey;
    next();
}

// 3. Get developer app info
app.get('/api/developer/info', authenticate, async (req, res) => {
    const app = req.developerApp;
    res.json({
        success: true,
        appName: app.name,
        apiKey: req.apiKey,
        webhookUrl: app.webhookUrl,
        createdAt: app.createdAt,
        totalRequests: app.totalRequests,
        balance: app.balance,
        currency: 'BRD'
    });
});

// 4. Update webhook URL
app.put('/api/developer/webhook', authenticate, async (req, res) => {
    const { webhookUrl } = req.body;
    
    const app = req.developerApp;
    app.webhookUrl = webhookUrl;
    developerApps.set(req.apiKey, app);
    
    res.json({
        success: true,
        webhookUrl: webhookUrl,
        message: 'Webhook URL updated successfully'
    });
});

// 5. Get webhook delivery logs
app.get('/api/developer/webhook-logs', authenticate, async (req, res) => {
    const limit = parseInt(req.query.limit) || 50;
    res.json({
        success: true,
        logs: webhookLogs.slice(0, limit),
        total: webhookLogs.length
    });
});

// 6. Create payment link (for receiving BRD)
app.post('/api/developer/create-payment', authenticate, async (req, res) => {
    try {
        const { amount, toAddress, callbackUrl, expiresInMinutes = 60, description } = req.body;
        
        // Validations
        if (!amount || amount <= 0) {
            return res.status(400).json({ error: 'Valid amount is required' });
        }
        
        if (amount < CONFIG.MINIMUM_PAYMENT) {
            return res.status(400).json({ error: `Minimum payment amount is ${CONFIG.MINIMUM_PAYMENT} BRD` });
        }
        
        if (amount > CONFIG.MAXIMUM_PAYMENT) {
            return res.status(400).json({ error: `Maximum payment amount is ${CONFIG.MAXIMUM_PAYMENT} BRD` });
        }
        
        if (!toAddress || !validateAddress(toAddress)) {
            return res.status(400).json({ error: 'Valid Bradicoin address is required' });
        }
        
        const paymentId = generatePaymentId();
        const expiresAt = new Date(Date.now() + (expiresInMinutes * 60 * 1000));
        
        paymentLinks.set(paymentId, {
            paymentId: paymentId,
            amount: parseFloat(amount),
            toAddress: toAddress,
            callbackUrl: callbackUrl || req.developerApp.webhookUrl,
            status: 'pending',
            createdAt: new Date().toISOString(),
            expiresAt: expiresAt.toISOString(),
            description: description || null,
            txHash: null,
            apiKey: req.apiKey
        });
        
        // Generate payment URL
        const paymentUrl = `https://www.bradichain.com/pay/${paymentId}`;
        
        res.json({
            success: true,
            paymentId: paymentId,
            paymentUrl: paymentUrl,
            amount: amount,
            toAddress: toAddress,
            expiresAt: expiresAt.toISOString(),
            currency: 'BRD',
            instructions: `Send exactly ${amount} BRD to ${toAddress} with payment ID: ${paymentId}`
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 7. Check payment status
app.get('/api/developer/payment/:paymentId', authenticate, async (req, res) => {
    const { paymentId } = req.params;
    
    const payment = paymentLinks.get(paymentId);
    if (!payment) {
        return res.status(404).json({ error: 'Payment not found' });
    }
    
    // Check if expired
    if (payment.status === 'pending' && new Date(payment.expiresAt) < new Date()) {
        payment.status = 'expired';
        paymentLinks.set(paymentId, payment);
    }
    
    res.json({
        success: true,
        paymentId: payment.paymentId,
        amount: payment.amount,
        status: payment.status,
        txHash: payment.txHash,
        createdAt: payment.createdAt,
        expiresAt: payment.expiresAt,
        currency: 'BRD'
    });
});

// 8. Send BRD transaction (withdrawal/payout)
app.post('/api/developer/send', authenticate, async (req, res) => {
    try {
        const { toAddress, amount, fromAddress, privateKey } = req.body;
        
        if (!toAddress || !validateAddress(toAddress)) {
            return res.status(400).json({ error: 'Valid destination address is required' });
        }
        
        if (!amount || amount <= 0) {
            return res.status(400).json({ error: 'Valid amount is required' });
        }
        
        if (amount < CONFIG.MINIMUM_PAYMENT) {
            return res.status(400).json({ error: `Minimum payment amount is ${CONFIG.MINIMUM_PAYMENT} BRD` });
        }
        
        // Use developer's wallet if fromAddress not provided
        let senderAddress = fromAddress;
        let senderPrivateKey = privateKey;
        
        if (!senderAddress) {
            // Auto-create wallet for developer if doesn't exist
            const devWallet = wallet.createWallet();
            senderAddress = devWallet.address;
            senderPrivateKey = devWallet.privateKey;
            
            // Update developer balance
            const app = req.developerApp;
            app.balance = wallet.getBalance(senderAddress);
            developerApps.set(req.apiKey, app);
        }
        
        // Execute transaction
        const result = wallet.sendTransaction(senderAddress, toAddress, parseFloat(amount), senderPrivateKey);
        
        // Try to mine immediately (in production, this would be async)
        try {
            const minedBlock = blockchain.minePendingTransactions(senderAddress);
            if (minedBlock) {
                // Confirm transaction
                wallet.confirmTransaction(result.transactionId);
            }
        } catch (miningError) {
            console.log('Transaction pending mining:', miningError.message);
        }
        
        // Send webhook notification
        if (req.developerApp.webhookUrl) {
            await sendWebhook(req.developerApp.webhookUrl, 'transaction.sent', {
                transactionId: result.transactionId,
                fromAddress: senderAddress,
                toAddress: toAddress,
                amount: amount,
                status: 'sent',
                currency: 'BRD'
            });
        }
        
        res.json({
            success: true,
            transactionId: result.transactionId,
            fromAddress: senderAddress,
            toAddress: toAddress,
            amount: amount,
            fee: result.fee,
            status: 'pending',
            currency: 'BRD',
            message: 'Transaction created successfully'
        });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// 9. Get balance for any address
app.get('/api/developer/balance/:address', authenticate, async (req, res) => {
    const { address } = req.params;
    
    if (!validateAddress(address)) {
        return res.status(400).json({ error: 'Invalid address format' });
    }
    
    const balance = wallet.getBalance(address);
    
    res.json({
        success: true,
        address: address,
        balance: balance,
        currency: 'BRD'
    });
});

// 10. Get transaction status
app.get('/api/developer/transaction/:txId', authenticate, async (req, res) => {
    const { txId } = req.params;
    
    try {
        const status = wallet.getTransactionStatus(txId);
        res.json({
            success: true,
            ...status
        });
    } catch (error) {
        res.status(404).json({ error: error.message });
    }
});

// 11. Get transaction history for an address
app.get('/api/developer/history/:address', authenticate, async (req, res) => {
    const { address } = req.params;
    const limit = parseInt(req.query.limit) || 50;
    const offset = parseInt(req.query.offset) || 0;
    
    if (!validateAddress(address)) {
        return res.status(400).json({ error: 'Invalid address format' });
    }
    
    try {
        const history = wallet.getTransactionHistory(address, limit, offset);
        res.json({
            success: true,
            ...history
        });
    } catch (error) {
        // If wallet doesn't exist, return empty history
        res.json({
            success: true,
            address: address,
            totalTransactions: 0,
            transactions: [],
            currency: 'BRD'
        });
    }
});

// 12. Get network information
app.get('/api/developer/network', authenticate, async (req, res) => {
    const chainInfo = blockchain.getChainInfo();
    const walletStats = wallet.getWalletStats();
    
    res.json({
        success: true,
        network: {
            name: 'Bradicoin Mainnet',
            symbol: 'BRD',
            chainId: '8888',
            blockHeight: chainInfo.totalBlocks,
            difficulty: chainInfo.difficulty,
            miningReward: chainInfo.miningReward,
            pendingTransactions: chainInfo.pendingTransactionsCount
        },
        stats: {
            totalWallets: walletStats.totalWallets,
            totalTransactions: walletStats.totalTransactions,
            totalBalance: walletStats.totalBalance,
            activeWallets: walletStats.activeWallets
        },
        fees: {
            transactionFee: walletStats.transactionFee,
            minTransactionAmount: walletStats.minTransactionAmount,
            currency: 'BRD'
        }
    });
});

// 13. Get current BRD price (market)
app.get('/api/developer/price', authenticate, async (req, res) => {
    // In production, fetch from real exchange
    const mockPrice = 10.00;
    
    res.json({
        success: true,
        symbol: 'BRD',
        price: mockPrice,
        currency: 'USD',
        lastUpdated: new Date().toISOString()
    });
});

// 14. Estimate transaction fee
app.post('/api/developer/estimate-fee', authenticate, async (req, res) => {
    const { amount } = req.body;
    
    if (!amount || amount <= 0) {
        return res.status(400).json({ error: 'Valid amount is required' });
    }
    
    const fee = amount * 0.001; // 0.1% fee
    const finalFee = Math.max(0.01, Math.min(fee, 10));
    
    res.json({
        success: true,
        amount: parseFloat(amount),
        fee: finalFee,
        total: parseFloat(amount) + finalFee,
        feePercentage: 0.1,
        currency: 'BRD'
    });
});

// 15. Create new wallet (for developer's users)
app.post('/api/developer/create-wallet', authenticate, async (req, res) => {
    const newWallet = wallet.createWallet();
    
    res.json({
        success: true,
        address: newWallet.address,
        privateKey: newWallet.privateKey, // ⚠️ Only show once!
        currency: 'BRD',
        warning: 'Save private key securely. It will not be shown again.'
    });
});

// 16. Webhook test endpoint
app.post('/api/developer/test-webhook', authenticate, async (req, res) => {
    const { webhookUrl, testEvent = 'test.webhook' } = req.body;
    
    if (!webhookUrl) {
        return res.status(400).json({ error: 'webhookUrl is required' });
    }
    
    const testData = {
        message: 'This is a test webhook from Bradicoin',
        timestamp: new Date().toISOString(),
        event: testEvent
    };
    
    const result = await sendWebhook(webhookUrl, testEvent, testData);
    
    res.json({
        success: result.success,
        webhookUrl: webhookUrl,
        statusCode: result.statusCode,
        message: result.success ? 'Webhook delivered successfully' : 'Webhook delivery failed'
    });
});

// 17. List all payments (for developer)
app.get('/api/developer/payments', authenticate, async (req, res) => {
    const limit = parseInt(req.query.limit) || 50;
    const status = req.query.status;
    
    let payments = [];
    for (const [id, payment] of paymentLinks) {
        if (payment.apiKey === req.apiKey) {
            if (!status || payment.status === status) {
                payments.push(payment);
            }
        }
    }
    
    payments.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    payments = payments.slice(0, limit);
    
    res.json({
        success: true,
        payments: payments,
        total: payments.length
    });
});

// 18. Simulate payment received (for testing)
app.post('/api/developer/simulate-payment', authenticate, async (req, res) => {
    const { paymentId, txHash } = req.body;
    
    const payment = paymentLinks.get(paymentId);
    if (!payment) {
        return res.status(404).json({ error: 'Payment not found' });
    }
    
    if (payment.apiKey !== req.apiKey) {
        return res.status(403).json({ error: 'Payment belongs to different app' });
    }
    
    // Update payment status
    payment.status = 'completed';
    payment.txHash = txHash || 'sim_' + crypto.randomBytes(16).toString('hex');
    payment.completedAt = new Date().toISOString();
    paymentLinks.set(paymentId, payment);
    
    // Credit the receiver wallet
    wallet.receiveCoins(payment.toAddress, payment.amount, 'payment_' + paymentId);
    
    // Send webhook notification
    if (payment.callbackUrl || req.developerApp.webhookUrl) {
        const webhookUrl = payment.callbackUrl || req.developerApp.webhookUrl;
        await sendWebhook(webhookUrl, 'payment.completed', {
            paymentId: payment.paymentId,
            amount: payment.amount,
            txHash: payment.txHash,
            toAddress: payment.toAddress,
            currency: 'BRD'
        });
    }
    
    res.json({
        success: true,
        paymentId: paymentId,
        status: 'completed',
        txHash: payment.txHash,
        message: 'Payment simulated successfully'
    });
});

// ==================== PUBLIC ENDPOINTS (for payment pages) ====================

// Get payment details (public - no auth)
app.get('/api/public/payment/:paymentId', async (req, res) => {
    const { paymentId } = req.params;
    
    const payment = paymentLinks.get(paymentId);
    if (!payment) {
        return res.status(404).json({ error: 'Payment not found' });
    }
    
    // Check if expired
    if (payment.status === 'pending' && new Date(payment.expiresAt) < new Date()) {
        payment.status = 'expired';
        paymentLinks.set(paymentId, payment);
    }
    
    res.json({
        success: true,
        paymentId: payment.paymentId,
        amount: payment.amount,
        status: payment.status,
        toAddress: payment.toAddress,
        description: payment.description,
        expiresAt: payment.expiresAt,
        currency: 'BRD'
    });
});

// ==================== DOCUMENTATION ====================

app.get('/api/developer/docs', (req, res) => {
    res.json({
        name: 'Bradicoin Developer API',
        version: '1.0.0',
        symbol: 'BRD',
        network: 'Mainnet',
        baseUrl: 'https://bradicoin-api.onrender.com/api/developer',
        authentication: {
            headers: {
                'X-API-Key': 'Your API Key from registration',
                'X-API-Secret': 'Your API Secret from registration'
            }
        },
        endpoints: {
            register: {
                method: 'POST',
                url: '/register',
                body: { appName: 'string', webhookUrl: 'string (optional)', email: 'string (optional)' }
            },
            createPayment: {
                method: 'POST',
                url: '/create-payment',
                body: { amount: 'number', toAddress: 'string', callbackUrl: 'string (optional)', expiresInMinutes: 'number' }
            },
            checkPayment: {
                method: 'GET',
                url: '/payment/:paymentId'
            },
            sendTransaction: {
                method: 'POST',
                url: '/send',
                body: { toAddress: 'string', amount: 'number', fromAddress: 'string (optional)', privateKey: 'string (optional)' }
            },
            getBalance: {
                method: 'GET',
                url: '/balance/:address'
            },
            getTransaction: {
                method: 'GET',
                url: '/transaction/:txId'
            },
            getHistory: {
                method: 'GET',
                url: '/history/:address'
            },
            getNetwork: {
                method: 'GET',
                url: '/network'
            },
            getPrice: {
                method: 'GET',
                url: '/price'
            },
            estimateFee: {
                method: 'POST',
                url: '/estimate-fee',
                body: { amount: 'number' }
            },
            createWallet: {
                method: 'POST',
                url: '/create-wallet'
            },
            getPayments: {
                method: 'GET',
                url: '/payments'
            },
            webhookLogs: {
                method: 'GET',
                url: '/webhook-logs'
            }
        },
        sdks: {
            javascript: 'npm install bradicoin-sdk',
            python: 'pip install bradicoin-sdk',
            curl: 'curl -X POST https://bradicoin-api.onrender.com/api/developer/...'
        }
    });
});

// Health check
app.get('/api/developer/health', (req, res) => {
    res.json({
        status: 'online',
        service: 'Bradicoin Developer API',
        symbol: 'BRD',
        timestamp: new Date().toISOString()
    });
});

// Start server
const PORT = process.env.DEVELOPER_API_PORT || 3001;
app.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════════════════════╗
║     BRADICOIN DEVELOPER API - READY FOR INTEGRATION      ║
╠══════════════════════════════════════════════════════════╣
║  🔗 API URL: http://localhost:${PORT}/api/developer        ║
║  🪙 Symbol: BRD (Bradicoin Mainnet)                       ║
║  📚 Documentation: http://localhost:${PORT}/api/developer/docs ║
║  ✅ Status: Online                                        ║
╠══════════════════════════════════════════════════════════╣
║  📝 Developer Features:                                  ║
║  • Create payment links                                  ║
║  • Send/receive BRD                                      ║
║  • Webhook notifications                                 ║
║  • Wallet management                                     ║
║  • Transaction history                                   ║
╚══════════════════════════════════════════════════════════╝
    `);
});

module.exports = app;
