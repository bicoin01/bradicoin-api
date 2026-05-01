const express = require('express');
const cors = require('cors');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// In-memory database
const wallets = [];
const transactions = [];

// MAIN ROUTE - TEST
app.get('/', (req, res) => {
    res.json({
        name: 'Bradicoin API',
        status: 'online',
        currency: 'BRD',
        message: 'API is working correctly!',
        endpoints: {
            health: 'GET /api/health',
            balance: 'GET /api/balance/:address',
            register: 'POST /api/register',
            send: 'POST /api/send'
        }
    });
});

// HEALTH CHECK
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        timestamp: new Date().toISOString(),
        currency: 'BRD',
        walletsCount: wallets.length
    });
});

// REGISTER WALLET
app.post('/api/register', (req, res) => {
    try {
        const { username, password } = req.body;
        
        if (!username || !password) {
            return res.status(400).json({ success: false, error: 'Username and password are required' });
        }
        
        // Check if user already exists
        const existing = wallets.find(w => w.username === username);
        if (existing) {
            return res.status(400).json({ success: false, error: 'Username already exists' });
        }
        
        // Limit to 3 users
        if (wallets.length >= 3) {
            return res.status(403).json({ success: false, error: 'Maximum limit of 3 users reached' });
        }
        
        // Generate BRD address
        const address = `Br${Date.now().toString(36)}${Math.random().toString(36).substring(2, 10)}`;
        const seedPhrase = Array(12).fill(0).map(() => {
            const words = ["abandon","ability","able","about","above","absent","absorb","abstract","absurd","abuse","access","accident","account","accuse","achieve","acid","acoustic","acquire","across","act","action","actor","actress","actual","adapt","add","addict","address","adjust","admit","adult","advance","advice"];
            return words[Math.floor(Math.random() * words.length)];
        }).join(' ');
        
        const RESERVE_SUPPLY = 99999999999999999;
        
        const newWallet = {
            id: wallets.length + 1,
            username,
            password,
            address,
            seedPhrase,
            balance: RESERVE_SUPPLY,
            createdAt: new Date().toISOString()
        };
        
        wallets.push(newWallet);
        
        res.json({
            success: true,
            message: 'Wallet created successfully!',
            data: {
                address,
                seedPhrase,
                balance: RESERVE_SUPPLY,
                username
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// CHECK BALANCE
app.get('/api/balance/:address', (req, res) => {
    try {
        const { address } = req.params;
        const wallet = wallets.find(w => w.address === address);
        
        if (!wallet) {
            return res.status(404).json({ success: false, error: 'Wallet not found' });
        }
        
        // Calculate balance based on transactions
        let balance = wallet.balance;
        
        // Apply transactions
        const walletTransactions = transactions.filter(t => t.toAddress === address || t.fromAddress === address);
        for (const tx of walletTransactions) {
            if (tx.toAddress === address) balance += tx.amount;
            if (tx.fromAddress === address) balance -= tx.amount;
        }
        
        res.json({
            success: true,
            data: {
                address,
                balance,
                currency: 'BRD'
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// SEND BRD
app.post('/api/send', (req, res) => {
    try {
        const { fromAddress, toAddress, amount } = req.body;
        
        if (!fromAddress || !toAddress || !amount) {
            return res.status(400).json({ success: false, error: 'Incomplete data' });
        }
        
        if (amount <= 0) {
            return res.status(400).json({ success: false, error: 'Amount must be greater than zero' });
        }
        
        const fromWallet = wallets.find(w => w.address === fromAddress);
        if (!fromWallet) {
            return res.status(404).json({ success: false, error: 'Sender wallet not found' });
        }
        
        // Calculate current balance
        let currentBalance = fromWallet.balance;
        const fromTransactions = transactions.filter(t => t.fromAddress === fromAddress || t.toAddress === fromAddress);
        for (const tx of fromTransactions) {
            if (tx.toAddress === fromAddress) currentBalance += tx.amount;
            if (tx.fromAddress === fromAddress) currentBalance -= tx.amount;
        }
        
        if (currentBalance < amount) {
            return res.status(400).json({ success: false, error: 'Insufficient balance' });
        }
        
        // Register transaction
        const transaction = {
            id: transactions.length + 1,
            fromAddress,
            toAddress,
            amount,
            timestamp: new Date().toISOString()
        };
        transactions.push(transaction);
        
        // Auto-repletion (0.5% bonus)
        const bonus = amount * 0.005;
        const bonusTransaction = {
            id: transactions.length + 1,
            fromAddress: null,
            toAddress: fromAddress,
            amount: amount + bonus,
            timestamp: new Date().toISOString(),
            isBonus: true
        };
        transactions.push(bonusTransaction);
        
        // Calculate new balance
        let newBalance = fromWallet.balance;
        const allFromTransactions = transactions.filter(t => t.toAddress === fromAddress || t.fromAddress === fromAddress);
        for (const tx of allFromTransactions) {
            if (tx.toAddress === fromAddress) newBalance += tx.amount;
            if (tx.fromAddress === fromAddress) newBalance -= tx.amount;
        }
        
        res.json({
            success: true,
            message: `Sent ${amount} BRD! ${bonus} BRD bonus credited.`,
            data: {
                fromAddress,
                toAddress,
                amount,
                bonus,
                newBalance
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// LIST ALL WALLETS
app.get('/api/wallets', (req, res) => {
    res.json({
        success: true,
        data: {
            total: wallets.length,
            max: 3,
            wallets: wallets.map(w => ({ username: w.username, address: w.address, balance: w.balance }))
        }
    });
});

// LIST TRANSACTIONS FOR ADDRESS
app.get('/api/transactions/:address', (req, res) => {
    const { address } = req.params;
    const walletTransactions = transactions.filter(t => t.fromAddress === address || t.toAddress === address);
    res.json({ success: true, data: { transactions: walletTransactions, count: walletTransactions.length } });
});

// Start server
app.listen(PORT, () => {
    console.log(`🚀 Bradicoin API running on port ${PORT}`);
    console.log(`💰 Currency: BRD`);
    console.log(`📡 URL: http://localhost:${PORT}`);
});
