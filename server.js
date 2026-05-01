const express = require('express');
const cors = require('cors');
const fs = require('fs');
const Blockchain = require('./blockchain');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const bradicoin = new Blockchain();
const WALLETS_FILE = './wallets.json';

function loadWallets() {
    try {
        if (fs.existsSync(WALLETS_FILE)) {
            return JSON.parse(fs.readFileSync(WALLETS_FILE, 'utf8'));
        }
    } catch (e) {}
    return [];
}

function saveWallets(wallets) {
    fs.writeFileSync(WALLETS_FILE, JSON.stringify(wallets, null, 2));
}

function generateSeedPhrase() {
    const words = ["abandon", "ability", "able", "about", "above", "absent", "absorb", "abstract", "absurd", "abuse", "access", "accident", "account", "accuse", "achieve", "acid", "acoustic", "acquire", "across", "act", "action", "actor", "actress", "actual", "adapt", "add", "addict", "address", "adjust", "admit", "adult", "advance", "advice", "aerobic", "affair", "afford", "afraid", "africa", "after", "again"];
    let result = [];
    for (let i = 0; i < 12; i++) result.push(words[Math.floor(Math.random() * words.length)]);
    return result.join(' ');
}

// ==================== ROTAS PRINCIPAIS ====================

app.get('/', (req, res) => {
    res.json({
        name: 'Bradicoin API',
        version: '2.0.0',
        currency: 'BRD',
        status: 'online',
        endpoints: {
            health: 'GET /api/health',
            balance: 'GET /api/balance/:address',
            register: 'POST /api/register',
            login: 'POST /api/login',
            send: 'POST /api/send',
            wallets: 'GET /api/wallets',
            blockchain: 'GET /api/blockchain'
        }
    });
});

app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString(), currency: 'BRD', wallets: loadWallets().length });
});

// REGISTRAR WALLET
app.post('/api/register', (req, res) => {
    try {
        const { username, password } = req.body;
        let wallets = loadWallets();
        
        if (wallets.find(w => w.username === username)) {
            return res.status(400).json({ success: false, error: 'Username already exists' });
        }
        if (wallets.length >= 3) {
            return res.status(403).json({ success: false, error: 'Maximum 3 users allowed' });
        }
        
        const seedPhrase = generateSeedPhrase();
        const walletAddress = `Br${Date.now().toString(36)}${Math.random().toString(36).substring(2, 10)}`;
        const RESERVE_SUPPLY = 99999999999999999;
        
        const newWallet = {
            id: Date.now(),
            username,
            password,
            address: walletAddress,
            seedPhrase,
            balance: RESERVE_SUPPLY,
            createdAt: new Date().toISOString()
        };
        
        wallets.push(newWallet);
        saveWallets(wallets);
        
        // Add to blockchain
        bradicoin.addTransaction({ fromAddress: null, toAddress: walletAddress, amount: RESERVE_SUPPLY });
        
        res.json({
            success: true,
            message: 'Wallet created!',
            data: { address: walletAddress, seedPhrase, balance: RESERVE_SUPPLY, username }
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// LOGIN
app.post('/api/login', (req, res) => {
    try {
        const { username, password } = req.body;
        const wallets = loadWallets();
        const wallet = wallets.find(w => w.username === username && w.password === password);
        
        if (!wallet) {
            return res.status(401).json({ success: false, error: 'Invalid credentials' });
        }
        
        res.json({
            success: true,
            data: {
                username: wallet.username,
                address: wallet.address,
                seedPhrase: wallet.seedPhrase,
                balance: bradicoin.getBalance(wallet.address)
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// CONSULTAR SALDO
app.get('/api/balance/:address', (req, res) => {
    try {
        const balance = bradicoin.getBalance(req.params.address);
        res.json({ success: true, data: { address: req.params.address, balance, currency: 'BRD' } });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ENVIAR BRD
app.post('/api/send', (req, res) => {
    try {
        const { fromAddress, toAddress, amount } = req.body;
        
        if (!fromAddress || !toAddress || !amount) {
            return res.status(400).json({ success: false, error: 'Missing fields' });
        }
        
        const currentBalance = bradicoin.getBalance(fromAddress);
        if (currentBalance < amount) {
            return res.status(400).json({ success: false, error: 'Insufficient balance' });
        }
        
        bradicoin.addTransaction({ fromAddress, toAddress, amount });
        
        // Auto-repletion with bonus
        const bonus = amount * 0.005;
        bradicoin.addTransaction({ fromAddress: null, toAddress: fromAddress, amount: amount + bonus });
        
        const newBalance = bradicoin.getBalance(fromAddress);
        
        res.json({
            success: true,
            message: `Sent ${amount} BRD! +${bonus} BRD bonus credited.`,
            data: { fromAddress, toAddress, amount, bonus, newBalance }
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// LISTAR WALLETS
app.get('/api/wallets', (req, res) => {
    const wallets = loadWallets();
    res.json({ success: true, data: { total: wallets.length, max: 3, wallets: wallets.map(w => ({ username: w.username, address: w.address })) } });
});

// BLOCKCHAIN
app.get('/api/blockchain', (req, res) => {
    res.json({ success: true, data: { chain: bradicoin.chain, length: bradicoin.chain.length } });
});

// TRANSAÇÕES
app.get('/api/transactions/:address', (req, res) => {
    const transactions = bradicoin.getAllTransactionsForAddress(req.params.address);
    res.json({ success: true, data: { transactions, count: transactions.length } });
});

app.listen(PORT, () => {
    console.log(`🚀 Bradicoin API running on port ${PORT}`);
    console.log(`💰 Currency: BRD`);
    console.log(`📡 URL: http://localhost:${PORT}`);
});
