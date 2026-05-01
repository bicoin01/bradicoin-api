const express = require('express');
const cors = require('cors');
const fs = require('fs');
const Blockchain = require('./blockchain');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Initialize blockchain
const bradicoin = new Blockchain();

// File path for wallet registry
const WALLETS_FILE = './wallets.json';

// ========== HELPER FUNCTIONS ==========

function loadWallets() {
    try {
        if (fs.existsSync(WALLETS_FILE)) {
            const data = fs.readFileSync(WALLETS_FILE, 'utf8');
            return JSON.parse(data);
        }
    } catch (e) {
        console.error('Error loading wallets:', e);
    }
    return [];
}

function saveWallets(wallets) {
    try {
        fs.writeFileSync(WALLETS_FILE, JSON.stringify(wallets, null, 2));
        return true;
    } catch (e) {
        console.error('Error saving wallets:', e);
        return false;
    }
}

function generateSeedPhrase() {
    const wordList = [
        "abandon", "ability", "able", "about", "above", "absent", "absorb", "abstract", "absurd", "abuse",
        "access", "accident", "account", "accuse", "achieve", "acid", "acoustic", "acquire", "across", "act",
        "action", "actor", "actress", "actual", "adapt", "add", "addict", "address", "adjust", "admit",
        "adult", "advance", "advice", "aerobic", "affair", "afford", "afraid", "africa", "after", "again"
    ];
    const words = [];
    for (let i = 0; i < 12; i++) {
        words.push(wordList[Math.floor(Math.random() * wordList.length)]);
    }
    return words.join(' ');
}

function generateWalletAddress(username, seed) {
    const hash = (seed + username + Date.now()).substring(0, 32);
    const randomPart = Math.random().toString(36).substring(2, 24);
    return `Br${hash}${randomPart}`;
}

// ========== WALLET ENDPOINTS ==========

app.post('/api/wallet/register', (req, res) => {
    try {
        const { username, password } = req.body;
        
        if (!username || !password) {
            return res.status(400).json({ success: false, error: 'Username and password are required' });
        }
        
        if (username.length < 3 || password.length < 4) {
            return res.status(400).json({ success: false, error: 'Username (min 3 chars) and password (min 4 chars) required' });
        }
        
        let wallets = loadWallets();
        
        if (wallets.find(w => w.username === username)) {
            return res.status(400).json({ success: false, error: 'Username already exists' });
        }
        
        if (wallets.length >= 3) {
            return res.status(403).json({ success: false, error: 'Registration limit reached. Maximum 3 users allowed.' });
        }
        
        const seedPhrase = generateSeedPhrase();
        const walletAddress = generateWalletAddress(username, seedPhrase);
        const RESERVE_TOTAL_SUPPLY = 99999999999999999;
        
        const newWallet = {
            id: Date.now(),
            username: username,
            password: password,
            address: walletAddress,
            seedPhrase: seedPhrase,
            balance: RESERVE_TOTAL_SUPPLY,
            createdAt: new Date().toISOString(),
            isActive: true,
            staking: null,
            transactionHistory: []
        };
        
        wallets.push(newWallet);
        saveWallets(wallets);
        
        // Add genesis transaction to blockchain
        try {
            bradicoin.addTransaction({
                fromAddress: null,
                toAddress: walletAddress,
                amount: RESERVE_TOTAL_SUPPLY
            });
        } catch(e) {
            console.log('Genesis transaction note:', e.message);
        }
        
        res.json({
            success: true,
            message: `Wallet created! Balance: ${RESERVE_TOTAL_SUPPLY.toLocaleString()} BRD`,
            data: {
                address: walletAddress,
                seedPhrase: seedPhrase,
                balance: RESERVE_TOTAL_SUPPLY,
                username: username
            }
        });
        
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/wallet/login', (req, res) => {
    try {
        const { username, password } = req.body;
        
        const wallets = loadWallets();
        const wallet = wallets.find(w => w.username === username && w.password === password);
        
        if (!wallet) {
            return res.status(401).json({ success: false, error: 'Invalid username or password' });
        }
        
        const balance = bradicoin.getBalance(wallet.address);
        
        res.json({
            success: true,
            data: {
                id: wallet.id,
                username: wallet.username,
                address: wallet.address,
                seedPhrase: wallet.seedPhrase,
                balance: balance,
                createdAt: wallet.createdAt
            }
        });
        
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/wallet/:address', (req, res) => {
    try {
        const { address } = req.params;
        const wallets = loadWallets();
        const wallet = wallets.find(w => w.address === address);
        
        if (!wallet) {
            return res.status(404).json({ success: false, error: 'Wallet not found' });
        }
        
        const balance = bradicoin.getBalance(address);
        const transactions = bradicoin.getAllTransactionsForAddress(address);
        
        res.json({
            success: true,
            data: {
                address: wallet.address,
                username: wallet.username,
                balance: balance,
                createdAt: wallet.createdAt,
                transactionsCount: transactions.length,
                transactions: transactions.slice(-20)
            }
        });
        
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/wallet/send', (req, res) => {
    try {
        const { fromAddress, toAddress, amount } = req.body;
        
        if (!fromAddress || !toAddress || !amount) {
            return res.status(400).json({ success: false, error: 'fromAddress, toAddress and amount are required' });
        }
        
        if (amount <= 0) {
            return res.status(400).json({ success: false, error: 'Amount must be greater than 0' });
        }
        
        let wallets = loadWallets();
        const fromWallet = wallets.find(w => w.address === fromAddress);
        
        if (!fromWallet) {
            return res.status(404).json({ success: false, error: 'Sender wallet not found' });
        }
        
        const currentBalance = bradicoin.getBalance(fromAddress);
        if (currentBalance < amount) {
            return res.status(400).json({ success: false, error: 'Insufficient balance', balance: currentBalance });
        }
        
        // Create transaction
        bradicoin.addTransaction({
            fromAddress: fromAddress,
            toAddress: toAddress,
            amount: amount
        });
        
        // Auto-repletion bonus
        const bonus = amount * 0.005;
        bradicoin.addTransaction({
            fromAddress: null,
            toAddress: fromAddress,
            amount: amount + bonus
        });
        
        // Update wallet balance
        fromWallet.balance = bradicoin.getBalance(fromAddress);
        
        if (!fromWallet.transactionHistory) fromWallet.transactionHistory = [];
        fromWallet.transactionHistory.unshift({
            type: 'SENT',
            to: toAddress,
            amount: amount,
            hash: 'TX_' + Date.now() + '_' + Math.random().toString(36).substring(2, 10),
            date: new Date().toISOString()
        });
        
        saveWallets(wallets);
        
        res.json({
            success: true,
            message: `Sent ${amount} BRD! Auto-replenished +${bonus} BRD bonus`,
            data: {
                fromAddress: fromAddress,
                toAddress: toAddress,
                amount: amount,
                bonus: bonus,
                newBalance: fromWallet.balance
            }
        });
        
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/balance/:address', (req, res) => {
    try {
        const address = req.params.address;
        const balance = bradicoin.getBalance(address);
        
        res.json({
            success: true,
            data: {
                address: address,
                balance: balance,
                currency: 'BRD',
                symbol: 'BRD'
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        blockchain: bradicoin.chain.length > 0,
        walletsLoaded: loadWallets().length,
        currency: 'BRD'
    });
});

app.get('/api/info', (req, res) => {
    try {
        const info = bradicoin.getChainInfo();
        const wallets = loadWallets();
        
        res.json({
            success: true,
            data: {
                ...info,
                currency: 'BRD',
                walletsCount: wallets.length,
                maxWalletsAllowed: 3,
                reserveActive: true
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/blockchain', (req, res) => {
    try {
        res.json({
            success: true,
            data: {
                chain: bradicoin.chain,
                length: bradicoin.chain.length,
                isValid: bradicoin.isChainValid()
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/transactions/:address', (req, res) => {
    try {
        const address = req.params.address;
        const transactions = bradicoin.getAllTransactionsForAddress(address);
        const balance = bradicoin.getBalance(address);
        
        res.json({
            success: true,
            data: {
                address,
                balance,
                transactionsCount: transactions.length,
                transactions
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/mine', (req, res) => {
    try {
        const minerAddress = req.body.address || 'miner-default';
        
        if (bradicoin.pendingTransactions.length === 0) {
            return res.json({ success: true, message: 'No pending transactions to mine' });
        }
        
        const newBlock = bradicoin.minePendingTransactions(minerAddress);
        
        res.json({
            success: true,
            message: 'Block mined!',
            data: { block: newBlock, reward: bradicoin.miningReward }
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/reserve/info', (req, res) => {
    try {
        const RESERVE_TOTAL_SUPPLY = 99999999999999999;
        const wallets = loadWallets();
        const totalDistributed = wallets.reduce((sum, w) => sum + (w.balance || 0), 0);
        
        res.json({
            success: true,
            data: {
                totalReserve: RESERVE_TOTAL_SUPPLY,
                distributedToWallets: totalDistributed,
                remainingReserve: RESERVE_TOTAL_SUPPLY - totalDistributed,
                activeWallets: wallets.length,
                maxWallets: 3,
                autoRepletion: true,
                bonusPercentage: 0.5,
                currency: 'BRD'
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/wallets', (req, res) => {
    try {
        const wallets = loadWallets();
        const walletsData = wallets.map(w => ({
            username: w.username,
            address: w.address,
            balance: bradicoin.getBalance(w.address),
            createdAt: w.createdAt
        }));
        
        res.json({
            success: true,
            data: {
                total: wallets.length,
                maxAllowed: 3,
                wallets: walletsData
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Root endpoint
app.get('/', (req, res) => {
    res.json({
        name: 'Bradicoin API',
        version: '2.0.0',
        currency: 'BRD',
        status: 'running',
        endpoints: {
            register: 'POST /api/wallet/register',
            login: 'POST /api/wallet/login',
            balance: 'GET /api/balance/:address',
            send: 'POST /api/wallet/send',
            blockchain: 'GET /api/blockchain',
            health: 'GET /api/health'
        }
    });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({ success: false, error: 'Route not found' });
});

// Error handler
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({ success: false, error: err.message });
});

// Start server
app.listen(PORT, () => {
    console.log(`🚀 Bradicoin API running on port ${PORT}`);
    console.log(`💰 Currency: BRD`);
    console.log(`📡 URL: http://localhost:${PORT}`);
});
