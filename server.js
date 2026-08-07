// ============================================
// LOAD ENVIRONMENT VARIABLES
// ============================================
require('dotenv').config();

// ============================================
// IMPORTS
// ============================================
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

// ============================================
// IMPORT NEW MODULES
// ============================================
const HashManager = require('./hash');
const BradicoinChecksum = require('./checksum');
const BradicoinValidator = require('./validator');
const BradicoinEncoding = require('./encoding');
const BradicoinWallet = require('./wallet');

// ============================================
// ENVIRONMENT VARIABLES VALIDATION
// ============================================
const requiredEnvVars = ['RPC_URL', 'CHAIN_ID'];
const missingVars = requiredEnvVars.filter(env => !process.env[env]);

if (missingVars.length > 0) {
    console.error('❌ ERROR: Required environment variables missing:');
    missingVars.forEach(v => console.error(`   - ${v}`));
    console.error('\n💡 Configure in .env or Render environment variables');
    process.exit(1);
}

// ============================================
// CONFIGURATION
// ============================================
const config = {
    port: process.env.PORT || 3000,
    host: process.env.HOST || '0.0.0.0',
    nodeEnv: process.env.NODE_ENV || 'development',
    rpcUrl: process.env.RPC_URL,
    rpcHost: process.env.RPC_HOST || '0.0.0.0',
    rpcPort: parseInt(process.env.RPC_PORT) || 8545,
    chainId: parseInt(process.env.CHAIN_ID) || 1337,
    dataDir: process.env.BRADICOIN_DATA_DIR || './bradicoin-data',
    coinName: process.env.COIN_NAME || 'Bradicoin',
    coinSymbol: process.env.COIN_SYMBOL || 'BRD',
    decimals: parseInt(process.env.DECIMALS) || 18,
    totalSupply: parseInt(process.env.TOTAL_SUPPLY) || 21000000,
    blockTime: parseInt(process.env.BLOCK_TIME) || 10,
    jwtSecret: process.env.JWT_SECRET || (() => { throw new Error('JWT_SECRET not set'); })(),
    apiKey: process.env.API_KEY,
    encryptionKey: process.env.ENCRYPTION_KEY,
    mongoUri: process.env.MONGODB_URI,
    redisUrl: process.env.REDIS_URL,
    infuraKey: process.env.INFURA_KEY,
    etherscanKey: process.env.ETHERSCAN_KEY,
    network: process.env.NETWORK || 'mainnet',
    // === NOVO: Endereço do minerador (pode ser configurado via env) ===
    minerAddress: process.env.MINER_ADDRESS || 'BrSystem'
};

// ============================================
// AUTHENTICATION HELPERS
// ============================================
const SALT_ROUNDS = 10;

async function hashPassword(password) {
    return await bcrypt.hash(password, SALT_ROUNDS);
}

async function verifyPassword(password, hash) {
    return await bcrypt.compare(password, hash);
}

function generateToken(payload) {
    return jwt.sign(payload, config.jwtSecret, { expiresIn: '24h' });
}

function authenticate(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
        return res.status(401).json({ success: false, error: 'Token não fornecido' });
    }
    const token = authHeader.split(' ')[1];
    try {
        const decoded = jwt.verify(token, config.jwtSecret);
        req.user = decoded;
        next();
    } catch (err) {
        return res.status(401).json({ success: false, error: 'Token inválido ou expirado' });
    }
}

console.log('📋 Configuration loaded:');
console.log(`   🚀 Server: ${config.host}:${config.port}`);
console.log(`   🔗 RPC URL: ${config.rpcUrl}`);
console.log(`   ⛓️  Chain ID: ${config.chainId}`);
console.log(`   🪙  Coin: ${config.coinName} (${config.coinSymbol})`);
console.log(`   📁 Data Dir: ${config.dataDir}`);
console.log(`   🌎 Environment: ${config.nodeEnv}`);
console.log(`   🔗 Network: ${config.network}`);
console.log(`   ⛏️  Miner Address: ${config.minerAddress}`); // NOVO

// ============================================
// INITIALIZE MODULES
// ============================================
const hashManager = new HashManager();
const checksumManager = new BradicoinChecksum();
const validator = new BradicoinValidator(config.network);
const encoding = new BradicoinEncoding(config.network);
const wallet = new BradicoinWallet(config.network);

console.log('✅ Modules initialized:');
console.log(`   🔐 Hash Manager: OK`);
console.log(`   ✅ Checksum Manager: OK`);
console.log(`   ✅ Validator: OK`);
console.log(`   📝 Encoding: OK`);
console.log(`   💳 Wallet: OK`);

// ============================================
// INITIALIZE APP
// ============================================
const app = express();

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Request logging middleware
app.use((req, res, next) => {
    console.log(`📥 ${req.method} ${req.path}`);
    if (req.body && Object.keys(req.body).length > 0 && req.path !== '/api/register' && req.path !== '/api/login') {
        console.log(`   Body:`, JSON.stringify(req.body).substring(0, 200));
    }
    if (req.query && Object.keys(req.query).length > 0) {
        console.log(`   Query:`, req.query);
    }
    next();
});

// ============================================
// PERSISTENT DATABASE (File-based - for dev only)
// ============================================
const DATA_FILE = path.join(config.dataDir, 'usuarios.json');

if (!fs.existsSync(config.dataDir)) {
    fs.mkdirSync(config.dataDir, { recursive: true });
    console.log(`📁 Created data directory: ${config.dataDir}`);
}

function loadUsers() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            const data = fs.readFileSync(DATA_FILE, 'utf8');
            const users = JSON.parse(data);
            console.log(`📊 Loaded ${users.length} users from database`);
            return users;
        }
    } catch (error) {
        console.error('❌ Error loading users:', error.message);
    }
    return [];
}

function saveUsers(users) {
    try {
        fs.writeFileSync(DATA_FILE, JSON.stringify(users, null, 2));
        console.log(`💾 Saved ${users.length} users to database`);
    } catch (error) {
        console.error('❌ Error saving users:', error.message);
    }
}

let users = loadUsers();

// ============================================
// BLOCKCHAIN ENGINE
// ============================================
const BLOCKCHAIN_FILE = path.join(config.dataDir, 'blockchain.json');

class Block {
    constructor(index, timestamp, transactions, previousHash = '', difficulty = 2) {
        this.index = index;
        this.timestamp = timestamp;
        this.transactions = transactions;
        this.previousHash = previousHash;
        this.nonce = 0;
        this.difficulty = difficulty;
        this.hash = this.calculateHash();
    }
    calculateHash() {
        const data = this.index + this.timestamp + JSON.stringify(this.transactions) + this.previousHash + this.nonce;
        return crypto.createHash('sha256').update(data).digest('hex');
    }
    mineBlock() {
        const target = '0'.repeat(this.difficulty);
        while (this.hash.substring(0, this.difficulty) !== target) {
            this.nonce++;
            this.hash = this.calculateHash();
        }
        console.log(`⛏️ Bloco ${this.index} minerado! Hash: ${this.hash}`);
    }
}

class Blockchain {
    constructor() {
        this.loadFromDisk();
        if (this.chain.length === 0) {
            this.chain = [this.createGenesis()];
            this.pending = [];
            this.balances = {};
            this.staking = {};
            this.history = [];
            this.difficulty = 2;
            // Parâmetros da recompensa (iguais ao Bitcoin)
            this.BASE_REWARD = 50;
            this.HALVING_INTERVAL = 210000;
            console.log('⚡ Nova blockchain criada');
            this.saveToDisk();
        }
        // Mineração automática a cada 30 segundos (usando o minerador configurado)
        setInterval(() => {
            if (this.pending.length > 0) {
                this.minePending(config.minerAddress);
            }
        }, 30000);
    }

    createGenesis() {
        // === GENESIS BLOCK AGORA TEM UM MINERADOR ===
        const genesisTx = {
            type: 'genesis',
            from: 'system',
            to: config.minerAddress, // <-- Endereço do minerador
            amount: config.totalSupply,
            txHash: '0x' + crypto.randomBytes(32).toString('hex'),
            timestamp: Date.now()
        };
        return new Block(0, Date.now(), [genesisTx], '0', this.difficulty || 2);
    }

    loadFromDisk() {
        try {
            if (fs.existsSync(BLOCKCHAIN_FILE)) {
                const data = JSON.parse(fs.readFileSync(BLOCKCHAIN_FILE, 'utf8'));
                this.chain = data.chain || [];
                this.pending = data.pending || [];
                this.balances = data.balances || {};
                this.staking = data.staking || {};
                this.history = data.history || [];
                this.difficulty = data.difficulty || 2;
                this.BASE_REWARD = data.baseReward || 50;
                this.HALVING_INTERVAL = data.halvingInterval || 210000;
                console.log(`📂 Blockchain carregada: ${this.chain.length} blocos`);
                return;
            }
        } catch (e) { console.error('Erro ao carregar blockchain:', e.message); }
        this.chain = [];
        this.pending = [];
        this.balances = {};
        this.staking = {};
        this.history = [];
        this.difficulty = 2;
        this.BASE_REWARD = 50;
        this.HALVING_INTERVAL = 210000;
    }

    saveToDisk() {
        try {
            const data = {
                chain: this.chain.map(b => ({ ...b })),
                pending: this.pending,
                balances: this.balances,
                staking: this.staking,
                history: this.history.slice(-1000),
                difficulty: this.difficulty,
                baseReward: this.BASE_REWARD,
                halvingInterval: this.HALVING_INTERVAL
            };
            fs.writeFileSync(BLOCKCHAIN_FILE, JSON.stringify(data, null, 2));
        } catch (e) { console.error('Erro ao salvar blockchain:', e.message); }
    }

    getLatest() { return this.chain[this.chain.length - 1]; }

    calculateReward(blockHeight) {
        const epochs = Math.floor(blockHeight / this.HALVING_INTERVAL);
        let reward = this.BASE_REWARD / Math.pow(2, epochs);
        reward = Math.max(1, Math.floor(reward));
        return reward;
    }

    createCoinbaseTransaction(minerAddress, blockHeight, pendingTxs) {
        const baseReward = this.calculateReward(blockHeight);
        const totalFees = pendingTxs.reduce((sum, tx) => sum + (tx.fee || 0), 0);
        return {
            type: 'coinbase',
            from: 'system',
            to: minerAddress,
            amount: baseReward + totalFees,
            fee: 0,
            txHash: '0x' + crypto.randomBytes(32).toString('hex'),
            timestamp: Date.now(),
            isCoinbase: true
        };
    }

    minePending(minerAddress) {
        if (this.pending.length === 0) return null;

        const nextHeight = this.chain.length;
        const coinbaseTx = this.createCoinbaseTransaction(minerAddress, nextHeight, this.pending);
        const allTxs = [coinbaseTx, ...this.pending];

        const block = new Block(
            nextHeight,
            Date.now(),
            allTxs,
            this.getLatest().hash,
            this.difficulty
        );
        block.mineBlock();

        const rewardAmount = coinbaseTx.amount;
        this.balances[minerAddress] = (this.balances[minerAddress] || 0) + rewardAmount;

        for (let i = 1; i < block.transactions.length; i++) {
            const tx = block.transactions[i];
            if (tx.type === 'transfer') {
                this.balances[tx.from] = (this.balances[tx.from] || 0) - tx.amount;
                this.balances[tx.to] = (this.balances[tx.to] || 0) + tx.amount;
            }
            if (tx.type === 'stake') {
                this.balances[tx.from] = (this.balances[tx.from] || 0) - tx.amount;
                this.staking[tx.from] = this.staking[tx.from] || { staked: 0, rewards: 0, lastUpdate: Date.now() };
                this.staking[tx.from].staked += tx.amount;
            }
            if (tx.type === 'unstake') {
                this.balances[tx.to] = (this.balances[tx.to] || 0) + tx.amount;
                if (this.staking[tx.from]) this.staking[tx.from].staked -= tx.amount;
            }
            if (tx.type === 'claim') {
                const rewards = this.staking[tx.to]?.rewards || 0;
                if (rewards > 0) {
                    this.balances[tx.to] = (this.balances[tx.to] || 0) + rewards;
                    this.staking[tx.to].rewards = 0;
                }
            }
            this.history.push({ ...tx, status: 'confirmed', blockIndex: block.index });
        }

        this.chain.push(block);
        this.pending = [];
        this.saveToDisk();

        console.log(`✅ Bloco ${block.index} minerado com ${block.transactions.length} txs (recompensa: ${rewardAmount} BRD)`);
        return block;
    }

    // ========== MÉTODOS PÚBLICOS ==========
    getBalance(address) {
        const user = users.find(u => u.address === address);
        if (user && !this.balances[address]) {
            this.balances[address] = user.balance || 0;
            this.saveToDisk();
        }
        return this.balances[address] || 0;
    }

    getStaking(address) {
        const s = this.staking[address] || { staked: 0, rewards: 0, lastUpdate: Date.now() };
        if (s.staked > 0) {
            const days = Math.floor((Date.now() - (s.lastUpdate || Date.now())) / (1000 * 60 * 60 * 24));
            const earned = s.staked * 0.00049 * Math.min(days, 365);
            s.rewards = (s.rewards || 0) + earned;
            s.lastUpdate = Date.now();
        }
        return s;
    }

    stake(address, amount) {
        const bal = this.getBalance(address);
        if (bal < amount) return { success: false, error: `Saldo: ${bal}` };
        this.balances[address] = bal - amount;
        this.staking[address] = this.staking[address] || { staked: 0, rewards: 0, lastUpdate: Date.now() };
        this.staking[address].staked += amount;
        this.addTransaction({ type: 'stake', from: address, to: address, amount, fee: 0 });
        const user = users.find(u => u.address === address);
        if (user) { user.balance = this.balances[address]; saveUsers(users); }
        this.saveToDisk();
        return { success: true, staked: this.staking[address].staked };
    }

    unstake(address, amount) {
        const s = this.staking[address];
        if (!s || s.staked < amount) return { success: false, error: 'Staked insuficiente' };
        this.balances[address] = (this.balances[address] || 0) + amount;
        s.staked -= amount;
        this.addTransaction({ type: 'unstake', from: address, to: address, amount, fee: 0 });
        const user = users.find(u => u.address === address);
        if (user) { user.balance = this.balances[address]; saveUsers(users); }
        this.saveToDisk();
        return { success: true };
    }

    claimRewards(address) {
        const s = this.staking[address];
        if (!s || s.rewards <= 0) return { success: false, error: 'Sem recompensas' };
        const amount = s.rewards;
        this.balances[address] = (this.balances[address] || 0) + amount;
        s.rewards = 0;
        this.addTransaction({ type: 'claim', from: 'system', to: address, amount, fee: 0 });
        const user = users.find(u => u.address === address);
        if (user) { user.balance = this.balances[address]; saveUsers(users); }
        this.saveToDisk();
        return { success: true, claimed: amount };
    }

    transfer(from, to, amount, fee = 0) {
        const bal = this.getBalance(from);
        const total = amount + fee;
        if (bal < total) return { success: false, error: `Saldo insuficiente: ${bal}` };
        this.balances[from] = bal - total;
        this.balances[to] = (this.balances[to] || 0) + amount;
        this.addTransaction({ type: 'transfer', from, to, amount, fee });
        const fromUser = users.find(u => u.address === from);
        const toUser = users.find(u => u.address === to);
        if (fromUser) { fromUser.balance = this.balances[from]; }
        if (toUser) { toUser.balance = this.balances[to]; }
        if (fromUser || toUser) saveUsers(users);
        this.saveToDisk();
        return { success: true, senderBalance: this.balances[from], recipientBalance: this.balances[to] };
    }

    addTransaction(tx) {
        if (!tx.from || !tx.to || !tx.amount || tx.amount <= 0) {
            return { success: false, error: 'Dados inválidos' };
        }
        if (tx.type !== 'deposit' && tx.type !== 'genesis' && tx.type !== 'stake' && tx.type !== 'unstake' && tx.type !== 'claim') {
            const bal = this.balances[tx.from] || 0;
            const total = tx.amount + (tx.fee || 0);
            if (bal < total) return { success: false, error: `Saldo insuficiente: ${bal}` };
        }
        tx.txHash = '0x' + crypto.createHash('sha256')
            .update(tx.from + tx.to + tx.amount + Date.now() + Math.random())
            .digest('hex').substring(0, 64);
        tx.timestamp = Date.now();
        this.pending.push(tx);

        if (tx.type === 'deposit') {
            this.balances[tx.to] = (this.balances[tx.to] || 0) + tx.amount;
            this.history.push({ ...tx, status: 'confirmed' });
        }

        if (this.pending.length >= 5) {
            this.minePending(config.minerAddress);
        }
        this.saveToDisk();
        return { success: true, message: 'Transação adicionada' };
    }

    getStats() {
        const totalStaked = Object.values(this.staking).reduce((s, v) => s + (v.staked || 0), 0);
        const active = Object.keys(this.balances).filter(k => this.balances[k] > 0).length;
        const circulating = Object.values(this.balances).reduce((a, b) => a + b, 0);
        return {
            blockHeight: this.chain.length,
            blocksPerMin: this.chain.length > 1 ? ((this.chain.length * 60000) / (Date.now() - this.chain[0].timestamp)).toFixed(1) : '0',
            avgBlockTime: this.chain.length > 1 ? ((Date.now() - this.chain[0].timestamp) / this.chain.length / 1000).toFixed(0) + 's' : '0s',
            nodesOnline: 1,
            validators: Object.keys(this.staking).filter(k => this.staking[k].staked > 0).length,
            networkHealth: 'N/A',
            decentralization: 'N/A',
            tps: 0,
            avgConfirmation: 'N/A',
            avgFee: 'N/A',
            volume24h: 'N/A',
            feesToday: 'N/A',
            pending: this.pending.length,
            activeWallets: active,
            newToday: 0,
            inStaking: totalStaked.toFixed(2) + ' BRD',
            topHolders: 'N/A',
            total: config.totalSupply,
            circulating: circulating,
            staked: totalStaked,
            deflation: '0%',
            basePrice: 0,
            currentPrice: 0,
            realMarketCap: 0,
            dilutedMC: 0,
            targetMC: 0,
            stabilityFund: 'N/A',
            boughtToday: '0 BRD',
            burnedToday: '0 BRD'
        };
    }

    getBlocks(limit = 20) {
        return this.chain.slice(-limit).reverse().map(b => {
            const minerTx = b.transactions.find(t => t.type === 'coinbase' || t.type === 'genesis');
            return {
                index: b.index,
                hash: b.hash,
                previousHash: b.previousHash,
                timestamp: b.timestamp,
                transactions: b.transactions.length,
                miner: minerTx ? minerTx.to : 'unknown'
            };
        });
    }

    getTransactions(limit = 50) {
        return this.history.slice(-limit).reverse();
    }
}

// Instancia a blockchain
const blockchain = new Blockchain();

// ============================================
// INTEGRAÇÃO COM USUÁRIOS EXISTENTES
// ============================================
users.forEach(u => {
    if (u.address) {
        blockchain.balances[u.address] = u.balance || 0;
    }
});
blockchain.saveToDisk();

// ============================================
// HEALTH CHECK ENDPOINT
// ============================================
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        config: {
            coin: config.coinName,
            symbol: config.coinSymbol,
            chainId: config.chainId,
            rpcUrl: config.rpcUrl,
            environment: config.nodeEnv,
            network: config.network,
            minerAddress: config.minerAddress // NOVO
        },
        modules: {
            hash: true,
            checksum: true,
            validator: true,
            encoding: true,
            wallet: true,
            blockchain: true
        },
        stats: {
            totalUsers: users.length,
            blockHeight: blockchain.chain.length,
            pendingTxs: blockchain.pending.length,
            dataDir: config.dataDir
        }
    });
});

// ============================================
// MAIN ROUTE
// ============================================
app.get('/', (req, res) => {
    res.json({
        name: config.coinName,
        version: '2.0.0',
        status: 'online',
        currency: config.coinSymbol,
        chainId: config.chainId,
        rpc: config.rpcUrl,
        network: config.network,
        miner: config.minerAddress, // NOVO
        modules: ['hash', 'checksum', 'validator', 'encoding', 'wallet', 'blockchain'],
        endpoints: {
            health: 'GET /health',
            register: 'POST /api/register',
            login: 'POST /api/login',
            balance: 'GET /api/balance/:address',
            send: 'POST /api/send (requires JWT)',
            users: 'GET /api/users',
            transactions: 'GET /api/transactions/:address',
            mine: 'POST /api/mine',
            stake: 'POST /api/stake (requires JWT)',
            unstake: 'POST /api/unstake (requires JWT)',
            claim: 'POST /api/claim (requires JWT)',
            explorer: 'GET /explorer',
            'explorer/transactions': 'GET /explorer/transactions',
            'explorer/stats': 'GET /explorer/stats',
            miner: 'GET /miner', // NOVO: retorna o endereço do minerador
            block: 'GET /block/:index', // NOVO: retorna detalhes de um bloco específico
            wallet: {
                create: 'POST /api/wallet/create',
                verify: 'POST /api/wallet/verify',
                wif: 'POST /api/wallet/wif',
                detect: 'POST /api/wallet/detect',
                generateKeys: 'POST /api/wallet/generate-keys',
                import: 'POST /api/wallet/import'
            },
            hash: { /* ... */ },
            checksum: { /* ... */ },
            encode: { /* ... */ },
            validate: { /* ... */ }
        },
        message: 'Bradicoin API v2.0 - Production Ready'
    });
});

// ============================================
// NOVA ROTA: /miner - retorna o endereço do minerador (para CoinGecko)
// ============================================
app.get('/miner', (req, res) => {
    res.json({
        success: true,
        miner: config.minerAddress,
        message: `Este é o endereço que recebe as recompensas de mineração. Use-o para o CoinGecko.`
    });
});

// ============================================
// NOVA ROTA: /block/:index - retorna detalhes de um bloco (JSON)
// ============================================
app.get('/block/:index', (req, res) => {
    const index = parseInt(req.params.index);
    if (isNaN(index) || index < 0 || index >= blockchain.chain.length) {
        return res.status(404).json({ success: false, error: 'Bloco não encontrado' });
    }
    const block = blockchain.chain[index];
    const minerTx = block.transactions.find(t => t.type === 'coinbase' || t.type === 'genesis');
    res.json({
        success: true,
        block: {
            index: block.index,
            hash: block.hash,
            previousHash: block.previousHash,
            timestamp: block.timestamp,
            transactions: block.transactions.length,
            miner: minerTx ? minerTx.to : 'unknown',
            nonce: block.nonce,
            difficulty: block.difficulty,
            transactionList: block.transactions.map(t => ({
                type: t.type,
                from: t.from,
                to: t.to,
                amount: t.amount,
                fee: t.fee || 0,
                txHash: t.txHash
            }))
        }
    });
});

// ============================================
// EXPLORER ROUTES (mantidos, com minerador corrigido)
// ============================================
app.get('/explorer', (req, res) => {
    const blocks = blockchain.getBlocks(20);
    const stats = blockchain.getStats();
    // Verifica se há um bloco específico solicitado via query ?block=0
    const blockIndex = req.query.block ? parseInt(req.query.block) : null;
    let targetBlock = null;
    if (blockIndex !== null && !isNaN(blockIndex) && blockIndex >= 0 && blockIndex < blockchain.chain.length) {
        targetBlock = blockchain.chain[blockIndex];
    }

    res.send(`
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Bradicoin Block Explorer</title>
        <style>
            * { margin:0; padding:0; box-sizing:border-box; }
            body { font-family: 'Courier New', monospace; background: #0a0a0f; color: #00ffff; padding: 20px; line-height: 1.6; }
            h1 { color: magenta; font-size: 2rem; margin-bottom: 10px; }
            .stats { display: flex; gap: 20px; flex-wrap: wrap; background: #111; padding: 15px; border-radius: 8px; margin-bottom: 20px; border: 1px solid cyan; }
            .stat-item { color: #888; }
            .stat-item span { color: #00ff66; font-weight: bold; }
            .block { background: #111; border: 1px solid #00ccff; padding: 15px; margin: 10px 0; border-radius: 8px; transition: 0.2s; }
            .block:hover { border-color: magenta; }
            .hash { color: #c864ff; font-size: 12px; word-break: break-all; }
            .tx { color: #ffc800; }
            .miner-info { color: #00ff66; font-weight: bold; }
            .nav { margin-top: 20px; display: flex; gap: 15px; flex-wrap: wrap; }
            .nav a { color: cyan; text-decoration: none; border: 1px solid cyan; padding: 8px 16px; border-radius: 6px; transition: 0.2s; }
            .nav a:hover { background: cyan; color: #000; }
            .highlight { border-color: magenta !important; background: #1a0a1f; }
            .alert { background: #ffcc00; color: #000; padding: 10px; border-radius: 6px; margin: 10px 0; }
        </style>
    </head>
    <body>
        <h1>📦 Bradicoin Block Explorer</h1>
        <div class="stats">
            <div class="stat-item">Block Height: <span>${stats.blockHeight}</span></div>
            <div class="stat-item">Nodes: <span>${stats.nodesOnline}</span></div>
            <div class="stat-item">Validators: <span>${stats.validators}</span></div>
            <div class="stat-item">Pending Txs: <span>${stats.pending}</span></div>
            <div class="stat-item">Total Supply: <span>${stats.total}</span></div>
            <div class="stat-item">Miner Address: <span style="color:#ffc800;">${config.minerAddress}</span></div>
        </div>
        ${targetBlock ? `
            <div class="alert">🔍 Exibindo detalhes do bloco #${targetBlock.index}</div>
            <div class="block highlight">
                <div><strong>Block #${targetBlock.index}</strong>  ⏱️ ${new Date(targetBlock.timestamp).toLocaleString()}</div>
                <div class="hash">Hash: ${targetBlock.hash}</div>
                <div class="hash">Previous: ${targetBlock.previousHash}</div>
                <div class="tx">Transactions: ${targetBlock.transactions.length}</div>
                <div class="miner-info">Miner: ${targetBlock.transactions.find(t => t.type === 'coinbase' || t.type === 'genesis')?.to || 'unknown'}</div>
                <div style="margin-top:10px;font-size:12px;color:#888;">Nonce: ${targetBlock.nonce} | Difficulty: ${targetBlock.difficulty}</div>
            </div>
        ` : ''}
        <h2 style="color:#ffc800;">Latest Blocks</h2>
        ${blocks.map(b => `
            <div class="block">
                <div><strong>Block #${b.index}</strong>  ⏱️ ${new Date(b.timestamp).toLocaleString()}</div>
                <div class="hash">Hash: ${b.hash}</div>
                <div class="tx">Transactions: ${b.transactions} | Miner: <span class="miner-info">${b.miner}</span></div>
            </div>
        `).join('')}
        <div class="nav">
            <a href="/explorer/transactions">📜 View All Transactions</a>
            <a href="/explorer/stats">📊 Network Stats</a>
            <a href="/">🏠 API Home</a>
            <a href="/miner">⛏️ Miner Address (JSON)</a>
        </div>
        <p style="margin-top:20px;color:#666;font-size:12px;">🔗 Para ver um bloco específico: <a href="/block/0" style="color:cyan;">/block/0</a></p>
    </body>
    </html>
    `);
});

app.get('/explorer/transactions', (req, res) => {
    const txs = blockchain.getTransactions(50);
    res.send(`
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="UTF-8">
        <title>Bradicoin Transactions</title>
        <style>
            * { margin:0; padding:0; box-sizing:border-box; }
            body { font-family: 'Courier New', monospace; background: #0a0a0f; color: #00ffff; padding: 20px; }
            h1 { color: magenta; }
            .tx { background: #111; border: 1px solid #c864ff; padding: 12px; margin: 8px 0; border-radius: 6px; transition:0.2s; }
            .tx:hover { border-color: #00ff66; }
            .hash { color: #c864ff; font-size: 11px; word-break: break-all; }
            .type { display: inline-block; padding: 2px 10px; border-radius: 12px; font-size: 11px; }
            .type.deposit { background: rgba(0,255,100,0.2); color: #00ff66; }
            .type.transfer { background: rgba(0,200,255,0.2); color: #00ccff; }
            .type.stake { background: rgba(255,200,0,0.2); color: #ffc800; }
            .type.unstake { background: rgba(255,100,100,0.2); color: #ff6464; }
            .type.claim { background: rgba(200,100,255,0.2); color: #c864ff; }
            .type.reward { background: rgba(255,200,0,0.3); color: #ffc800; }
            .type.genesis { background: rgba(0,255,255,0.2); color: cyan; }
            .nav { margin-top: 20px; }
            .nav a { color: cyan; text-decoration: none; border: 1px solid cyan; padding: 8px 16px; border-radius: 6px; }
            .nav a:hover { background: cyan; color: #000; }
        </style>
    </head>
    <body>
        <h1>📜 Recent Transactions (${txs.length})</h1>
        ${txs.map(t => `
            <div class="tx">
                <div>
                    <span class="type ${t.type || 'unknown'}">${(t.type || 'UNKNOWN').toUpperCase()}</span>
                    <span style="color:#fff;font-weight:bold;">${t.amount || 0} BRD</span>
                </div>
                <div>From: ${t.from || 'system'} → To: ${t.to || 'system'}</div>
                <div class="hash">${t.txHash || 'N/A'}</div>
                <div style="color:#888;font-size:10px;">${new Date(t.timestamp || Date.now()).toLocaleString()}</div>
            </div>
        `).join('')}
        <div class="nav">
            <a href="/explorer">← Back to Blocks</a>
        </div>
    </body>
    </html>
    `);
});

app.get('/explorer/stats', (req, res) => {
    const s = blockchain.getStats();
    res.send(`
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="UTF-8">
        <title>Bradicoin Network Stats</title>
        <style>
            * { margin:0; padding:0; box-sizing:border-box; }
            body { font-family: 'Courier New', monospace; background: #0a0a0f; color: #00ffff; padding: 20px; }
            h1 { color: magenta; }
            .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px,1fr)); gap: 15px; margin: 20px 0; }
            .card { background: #111; padding: 15px; border-radius: 8px; border: 1px solid #333; text-align: center; }
            .card .label { color: #888; font-size: 12px; }
            .card .value { font-size: 22px; font-weight: bold; margin-top: 5px; color: #00ff66; }
            .nav { margin-top: 20px; }
            .nav a { color: cyan; text-decoration: none; border: 1px solid cyan; padding: 8px 16px; border-radius: 6px; }
            .nav a:hover { background: cyan; color: #000; }
        </style>
    </head>
    <body>
        <h1>📊 Network Statistics</h1>
        <div class="grid">
            <div class="card"><div class="label">Block Height</div><div class="value">${s.blockHeight}</div></div>
            <div class="card"><div class="label">Nodes Online</div><div class="value">${s.nodesOnline}</div></div>
            <div class="card"><div class="label">Validators</div><div class="value">${s.validators}</div></div>
            <div class="card"><div class="label">Pending Txs</div><div class="value">${s.pending}</div></div>
            <div class="card"><div class="label">Active Wallets</div><div class="value">${s.activeWallets}</div></div>
            <div class="card"><div class="label">Total Staked</div><div class="value">${s.inStaking}</div></div>
            <div class="card"><div class="label">Circulating</div><div class="value">${s.circulating.toFixed(0)} BRD</div></div>
        </div>
        <div class="nav"><a href="/explorer">← Back to Blocks</a></div>
    </body>
    </html>
    `);
});

// ============================================
// ENDPOINTS AUTENTICADOS (com JWT)
// ============================================

// Registro (não autenticado)
app.post('/api/register', async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password) {
            return res.status(400).json({ success: false, error: 'Username and password are required' });
        }
        if (username.length < 3) {
            return res.status(400).json({ success: false, error: 'Username must be at least 3 characters' });
        }
        if (password.length < 6) {
            return res.status(400).json({ success: false, error: 'Password must be at least 6 characters' });
        }
        const existingUser = users.find(u => u.username === username);
        if (existingUser) {
            return res.status(400).json({ success: false, error: 'Username already exists' });
        }

        // Geração de chaves
        const privateKey = crypto.randomBytes(32).toString('hex');
        const publicKey = wallet._derivePublicKey(privateKey);
        const address = encoding.publicKeyToAddress(publicKey);

        // Seed phrase
        const wordList = ["abandon","ability","able","about","above","absent","absorb","abstract","absurd","abuse","access","accident","account","accuse","achieve","acid","acoustic","acquire","across","act","action","actor","actress","actual","adapt","add","addict","address","adjust","admit","adult","advance","advice","aerobic","affair","afford","afraid","again","age","agent","agree","ahead","aim","air","airport","aisle","alarm","album","alcohol","alert","alien","all","alley","allow","almost","alone","alpha","already","also","alter","always","amateur","amazing","among","amount","amused","analyst","anchor","ancient","anger","angle","angry","animal","ankle","announce","annual","another","answer","antenna","antique","anxiety","any","apart","apology","appear","apple","approve","april","arch","arctic","area","arena","argue","arm","armed","armor","army","around","arrange","arrest","arrive","arrow","art","artefact","artist","artwork","ask","aspect","assault","asset","assist","assume","asthma","athlete","atom","attack","attend","attitude","attract","auction","audit","august","aunt","author","auto","autumn","average","avocado","avoid","awake","aware","away","awesome","awful","awkward","axis","baby","bachelor","bacon","badge","bag","balance","balcony","ball","bamboo","banana","banner","bar","barely","bargain","barrel","base","basic","basket","battle","beach","bean","beauty","because","become","beef","before","begin","behave","behind","believe","below","belt","bench","benefit","best","betray","better","between","beyond","bicycle","bid","bike","bind","biology","bird","birth","bitter","black","blade","blame","blanket","blast","bleak","bless","blind","blood","blossom","blouse","blue","blur","blush","board","boat","body","boil","bomb","bone","bonus","book","boost","border","boring","borrow","boss","bottom","bounce","box","boy","bracket","brain","brand","brass","brave","bread","breeze","brick","bridge","brief","bright","bring","brisk","broccoli","broken","bronze","broom","brother","brown","brush","bubble","buddy","budget","buffalo","build","bulb","bulk","bullet","bundle","bunker","burden","burger","burst","bus","business","busy","butter","buyer","buzz","cabbage","cabin","cable","cactus","cage","cake","call","calm","camera","camp","can","canal","cancel","candy","cannon","canoe","canvas","canyon","capable","capital","captain","car","carbon","card","cargo","carpet","carry","cart","case","cash","casino","castle","casual","cat","catalog","catch","category","cattle","caught","cause","caution","cave","ceiling","celery","cement","census","century","cereal","certain","chair","chalk","champion","change","chaos","chapter","charge","chase","chat","cheap","check","cheese","chef","cherry","chest","chicken","chief","child","chimney","choice","choose","chronic","chuckle","chunk","churn","cigar","cinnamon","circle","citizen","city","civil","claim","clap","clarify","claw","clay","clean","clerk","clever","click","client","cliff","climb","clinic","clip","clock","clog","close","cloth","cloud","clown","club","clump","cluster","clutch","coach","coast","coconut","code","coffee","coil","coin","collect","color","column","combine","come","comfort","comic","common","company","concert","conduct","confirm","congress","connect","consider","control","convince","cook","cool","copper","copy","coral","core","corn","correct","cost","cotton","couch","country","couple","course","cousin","cover","coyote","crack","cradle","craft","cram","crane","crash","crater","crawl","crazy","cream","credit","creek","crew","cricket","crime","crisp","critic","crop","cross","crouch","crowd","crucial","cruel","cruise","crumble","crunch","crush","cry","crystal","cube","culture","cup","cupboard","curious","current","curtain","curve","cushion","custom","cute","cycle","dad","damage","damp","dance","danger","daring","dash","daughter","dawn","day","deal","debate","debris","decade","december","decide","decline","decorate","decrease","deer","defense","define","defy","degree","delay","deliver","demand","demise","denial","dentist","deny","depart","depend","deposit","depth","deputy","derive","describe","desert","design","desk","despair","destroy","detail","detect","develop","device","devote","diagram","dial","diamond","diary","dice","diesel","diet","differ","digital","dignity","dilemma","dinner","dinosaur","direct","dirt","disagree","discover","disease","dish","dismiss","disorder","display","distance","divert","divide","divorce","dizzy","doctor","document","dog","doll","dolphin","domain","donate","donkey","donor","door","dose","double","dove","draft","dragon","drama","drastic","draw","dream","dress","drift","drill","drink","drip","drive","drop","drum","dry","duck","dumb","dune","during","dust","dutch","duty","dwarf","dynamic","eager","eagle","early","earn","earth","easily","east","easy","echo","ecology","economy","edge","edit","educate","effort","egg","eight","either","elbow","elder","electric","elegant","element","elephant","elevator","elite","else","embark","embody","embrace","emerge","emotion","employ","empower","empty","enable","enact","end","endless","endorse","enemy","energy","enforce","engage","engine","enhance","enjoy","enlist","enough","enrich","enroll","ensure","enter","entire","entry","envelope","episode","equal","equip","era","erase","erode","erosion","error","erupt","escape","essay","essence","estate","eternal","ethics","evidence","evil","evoke","evolve","exact","example","excess","exchange","excite","exclude","excuse","execute","exercise","exhaust","exhibit","exile","exist","exit","exotic","expand","expect","expire","explain","expose","express","extend","extra","eye","eyebrow","fabric","face","faculty","fade","faint","faith","fall","false","fame","family","famous","fan","fancy","fantasy","farm","fashion","fat","fatal","father","fatigue","fault","favorite","feature","february","federal","fee","feed","feel","female","fence","festival","fetch","fever","few","fiber","fiction","field","figure","file","film","filter","final","find","fine","finger","finish","fire","firm","first","fiscal","fish","fit","fitness","fix","flag","flame","flash","flat","flavor","flee","flight","flip","float","flock","floor","flower","fluid","flush","fly","foam","focus","fog","foil","fold","follow","food","foot","force","forest","forget","fork","fortune","forum","forward","fossil","foster","found","fox","fragile","frame","frequent","fresh","friend","fringe","frog","front","frost","frown","frozen","fruit","fuel","fun","funny","furnace","fury","future","gadget","gain","galaxy","gallery","game","gap","garage","garbage","garden","garlic","garment","gas","gasp","gate","gather","gauge","gaze","general","genius","genre","gentle","genuine","gesture","ghost","giant","gift","giggle","ginger","giraffe","girl","give","glad","glance","glare","glass","glide","glimpse","globe","gloom","glory","glove","glow","glue","goat","goddess","gold","good","goose","gorilla","gospel","gossip","govern","gown","grab","grace","grain","grant","grape","grass","gravity","great","green","grid","grief","grit","grocery","group","grow","grunt","guard","guess","guide","guilt","guitar","gun","gym","habit","hair","half","hammer","hamster","hand","happy","harbor","hard","harsh","harvest","hat","have","hawk","hazard","head","health","heart","heavy","hedgehog","height","hello","helmet","help","hen","hero","hidden","high","hill","hint","hip","hire","history","hobby","hockey","hold","hole","holiday","hollow","home","honey","hood","hope","horn","horror","horse","hospital","host","hotel","hour","hover","hub","human","humble","humor","hundred","hungry","hunt","hurdle","hurry","hurt","husband","hybrid","ice","icon","idea","identify","idle","ignore","ill","illegal","illness","image","imitate","immense","immune","impact","impose","improve","impulse","inch","include","income","increase","index","indicate","indoor","industry","infant","inflict","inform","inhale","inherit","initial","inject","injury","inmate","inner","innocent","input","inquiry","insane","insect","inside","inspire","install","intact","interest","into","invest","invite","involve","iron","island","isolate","issue","item","ivory","jacket","jaguar","jar","jazz","jealous","jeans","jelly","jewel","job","join","joke","journey","joy","judge","juice","jump","jungle","junior","junk","just","kangaroo","keen","keep","ketchup","key","kick","kid","kidney","kind","kingdom","kiss","kit","kitchen","kite","kitten","kiwi","knee","knife","knock","know","lab","label","labor","ladder","lady","lake","lamp","language","laptop","large","later","latin","laugh","laundry","lava","law","lawn","lawsuit","layer","lazy","leader","leaf","learn","leave","lecture","left","leg","legal","legend","leisure","lemon","lend","length","lens","leopard","lesson","letter","level","liar","liberty","library","license","life","lift","light","like","limb","limit","link","lion","liquid","list","little","live","lizard","load","loan","lobster","local","lock","logic","lonely","long","loop","lottery","loud","lounge","love","loyal","lucky","luggage","lumber","lunar","lunch","luxury","lyrics","machine","mad","magic","magnet","maid","mail","main","major","make","mammal","man","manage","mandate","mango","mansion","manual","maple","marble","march","margin","marine","market","marriage","mask","mass","master","match","material","math","matrix","matter","maximum","maze","meadow","mean","measure","meat","mechanic","medal","media","melody","melt","member","memory","mention","menu","mercy","merge","merit","merry","mesh","message","metal","method","middle","midnight","milk","million","mimic","mind","minimum","minor","minute","miracle","mirror","misery","miss","mistake","mix","mixed","mixture","mobile","model","modify","mom","moment","monitor","monkey","monster","month","moon","moral","more","morning","mosquito","mother","motion","motor","mountain","mouse","move","movie","much","muffin","mule","multiply","muscle","museum","mushroom","music","must","mutual","myself","mystery","myth","naive","name","napkin","narrow","nasty","nation","nature","near","neck","need","negative","neglect","neither","nephew","nerve","nest","net","network","neutral","never","news","next","nice","night","noble","noise","nominee","noodle","normal","north","nose","notable","note","nothing","notice","novel","now","nuclear","number","nurse","nut","oak","obey","object","oblige","obscure","observe","obtain","obvious","occur","ocean","october","odor","off","offer","office","often","oil","okay","old","olive","olympic","omit","once","one","onion","online","only","open","opera","opinion","oppose","option","orange","orbit","orchard","order","ordinary","organ","orient","original","orphan","ostrich","other","outdoor","outer","output","outside","oval","oven","over","own","owner","oxygen","oyster","ozone","pact","paddle","page","pair","palace","palm","panda","panel","panic","panther","paper","parade","parent","park","parrot","party","pass","patch","path","patient","patrol","pattern","pause","pave","payment","peace","peanut","pear","peasant","pelican","pen","penalty","pencil","people","pepper","perfect","permit","person","pet","phone","photo","phrase","physical","piano","picnic","picture","piece","pig","pigeon","pill","pilot","pink","pioneer","pipe","pistol","pitch","pizza","place","planet","plastic","plate","play","please","pledge","pluck","plug","plunge","poem","poet","point","polar","pole","police","pond","pony","pool","popular","portion","position","possible","post","potato","pottery","poverty","powder","power","practice","praise","predict","prefer","prepare","present","pretty","prevent","price","pride","primary","print","priority","prison","private","prize","problem","process","produce","profit","program","project","promote","proof","property","prosper","protect","proud","provide","public","pudding","pull","pulp","pulse","pumpkin","punch","pupil","puppy","purchase","purity","purpose","purse","push","put","puzzle","pyramid","quality","quantum","quarter","question","quick","quit","quiz","quote","rabbit","raccoon","race","rack","radar","radio","rail","rain","raise","rally","ramp","ranch","random","range","rapid","rare","rate","rather","raven","raw","razor","ready","real","reason","rebel","rebuild","recall","receive","recipe","record","recycle","reduce","reflect","reform","refuse","region","regret","regular","reject","relax","release","relief","rely","remain","remember","remind","remove","render","renew","rent","reopen","repair","repeat","replace","report","require","rescue","resemble","resist","resource","response","result","retire","retreat","return","reunion","reveal","review","revolution","reward","rhythm","rib","ribbon","rice","rich","ride","ridge","rifle","right","rigid","ring","riot","ripple","risk","ritual","rival","river","road","roast","robot","robust","rocket","romance","roof","rookie","room","rose","rotate","rough","round","route","royal","rubber","rude","rug","rule","run","runway","rural","sad","saddle","sadness","safe","sail","salad","salmon","salon","salt","salute","same","sample","sand","satisfy","satoshi","sauce","sausage","save","say","scale","scan","scare","scatter","scene","scheme","school","science","scissors","scorpion","scout","scrap","screen","script","scrub","sea","search","season","seat","second","secret","section","security","seed","seek","segment","select","sell","seminar","senior","sense","sentence","series","service","session","settle","setup","seven","shadow","shaft","shallow","share","shed","shell","sheriff","shield","shift","shine","ship","shiver","shock","shoe","shoot","shop","short","shoulder","shove","shrimp","shrug","shuffle","shy","sibling","sick","side","siege","sight","sign","silent","silk","silly","silver","similar","simple","since","sing","siren","sister","situate","six","size","skate","sketch","ski","skill","skin","skirt","skull","slab","slam","sleep","slender","slice","slide","slight","slim","slogan","slot","slow","slush","small","smart","smile","smoke","smooth","snack","snake","snap","sniff","snow","soap","soccer","social","sock","soda","soft","solar","soldier","solid","solution","solve","someone","song","soon","sorry","sort","soul","sound","soup","source","south","space","spare","spatial","spawn","speak","special","speed","spell","spend","sphere","spice","spider","spike","spin","spirit","split","spoil","sponsor","spoon","sport","spot","spray","spread","spring","spy","square","squeeze","squirrel","stable","stadium","staff","stage","stairs","stamp","stand","start","state","stay","steak","steel","stem","step","stereo","stick","still","sting","stock","stomach","stone","stool","story","stove","strategy","street","strike","strong","struggle","student","stuff","stumble","style","subject","submit","subway","success","such","sudden","suffer","sugar","suggest","suit","summer","sun","sunny","sunset","super","supply","supreme","sure","surface","surge","surprise","surround","survey","suspect","sustain","swallow","swamp","swap","swarm","swear","sweet","swift","swim","swing","switch","sword","symbol","symptom","syrup","system","table","tackle","tag","tail","talent","talk","tank","tape","target","task","taste","tattoo","taxi","teach","team","tell","ten","tenant","tennis","tent","term","test","text","thank","that","theme","then","theory","there","they","thing","this","thought","three","thrive","throw","thumb","thunder","ticket","tide","tiger","tilt","timber","time","tiny","tip","tired","tissue","title","toast","tobacco","today","toddler","toe","together","toilet","token","tomato","tomorrow","tone","tongue","tonight","tool","tooth","top","topic","topple","torch","tornado","tortoise","toss","total","tourist","toward","tower","town","toy","track","trade","traffic","tragic","train","transfer","trap","trash","travel","tray","treat","tree","trend","trial","tribe","trick","trigger","trim","trip","trophy","trouble","truck","true","truly","trumpet","trust","truth","try","tube","tuition","tumble","tuna","tunnel","turkey","turn","turtle","twelve","twenty","twice","twin","twist","two","type","typical","ugly","umbrella","unable","unaware","uncle","uncover","under","undo","unfair","unfold","unhappy","uniform","unique","unit","universe","unknown","unlock","until","unusual","unveil","update","upgrade","uphold","upon","upper","upset","urban","urge","usage","use","used","useful","useless","usual","utility","vacant","vacuum","vague","valid","valley","valve","van","vanish","vapor","various","vast","vault","vehicle","velvet","vendor","venture","venue","verb","verify","version","very","vessel","veteran","viable","vibrant","vicious","victory","video","view","village","vintage","violin","virtual","virus","visa","visit","visual","vital","vivid","vocal","voice","void","volcano","volume","vote","voyage","wage","wagon","wait","walk","wall","walnut","want","warfare","warm","warrior","wash","wasp","waste","water","wave","way","wealth","weapon","wear","weasel","weather","web","wedding","weekend","weird","welcome","west","wet","whale","what","wheat","wheel","when","where","whip","whisper","wide","width","wife","wild","will","win","window","wine","wing","wink","winner","winter","wire","wisdom","wise","wish","witness","wolf","woman","wonder","wood","wool","word","work","world","worry","worth","wrap","wreck","wrestle","wrist","write","wrong","yard","year","yellow","you","young","youth","zebra","zero","zone","zoo"];
        const seedPhrase = Array(12).fill(0).map(() => wordList[Math.floor(Math.random() * wordList.length)]).join(' ');

        const INITIAL_BALANCE = 99999999999999999;

        const hashedPassword = await hashPassword(password);

        const newUser = {
            id: users.length + 1,
            username,
            password: hashedPassword,
            address,
            privateKey,
            seedPhrase,
            balance: INITIAL_BALANCE,
            createdAt: new Date().toISOString(),
            addressFormat: 'standard'
        };

        users.push(newUser);
        saveUsers(users);

        blockchain.balances[address] = INITIAL_BALANCE;
        blockchain.saveToDisk();

        const token = generateToken({ username, address });

        console.log(`✅ New user registered: ${username} (${address})`);

        res.json({
            success: true,
            message: 'Wallet created successfully!',
            data: {
                address,
                username,
                balance: INITIAL_BALANCE,
                currency: config.coinSymbol,
                createdAt: newUser.createdAt,
                addressFormat: 'standard (Base58Check)',
                token
            }
        });
    } catch (error) {
        console.error('❌ Registration error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Login
app.post('/api/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        const user = users.find(u => u.username === username);
        if (!user) {
            return res.status(401).json({ success: false, error: 'Usuário não encontrado' });
        }
        const valid = await verifyPassword(password, user.password);
        if (!valid) {
            return res.status(401).json({ success: false, error: 'Senha incorreta' });
        }
        const token = generateToken({ username, address: user.address });
        res.json({
            success: true,
            token,
            address: user.address,
            username: user.username
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================
// ENDPOINTS PROTEGIDOS (JWT)
// ============================================

app.post('/api/send', authenticate, async (req, res) => {
    try {
        const { fromAddress, toAddress, amount, fee } = req.body;
        if (fromAddress !== req.user.address) {
            return res.status(403).json({ success: false, error: 'Você só pode enviar da sua própria carteira' });
        }
        if (!fromAddress || !toAddress || !amount) {
            return res.status(400).json({ success: false, error: 'fromAddress, toAddress e amount são obrigatórios' });
        }
        if (amount <= 0) {
            return res.status(400).json({ success: false, error: 'Amount deve ser maior que 0' });
        }

        const fromValidation = validator.validateAddress(fromAddress);
        const toValidation = validator.validateAddress(toAddress);
        if (!fromValidation.valid) {
            return res.status(400).json({ success: false, error: 'Endereço de origem inválido' });
        }
        if (!toValidation.valid) {
            return res.status(400).json({ success: false, error: 'Endereço de destino inválido' });
        }

        const feeAmount = parseFloat(fee) || 0;
        const result = blockchain.transfer(fromAddress, toAddress, parseFloat(amount), feeAmount);
        if (!result.success) {
            return res.status(400).json({ success: false, error: result.error });
        }

        const fromUser = users.find(u => u.address === fromAddress);
        const toUser = users.find(u => u.address === toAddress);
        if (fromUser) fromUser.balance = result.senderBalance;
        if (toUser) toUser.balance = result.recipientBalance;
        if (fromUser || toUser) saveUsers(users);

        res.json({
            success: true,
            message: 'Transação realizada com sucesso!',
            data: {
                txHash: crypto.randomBytes(32).toString('hex'),
                fromAddress,
                toAddress,
                amount: parseFloat(amount),
                fee: feeAmount,
                newBalance: result.senderBalance,
                currency: config.coinSymbol,
                timestamp: new Date().toISOString()
            }
        });
    } catch (error) {
        console.error('❌ Transfer error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/stake', authenticate, (req, res) => {
    try {
        const { address, amount } = req.body;
        if (address !== req.user.address) {
            return res.status(403).json({ success: false, error: 'Você só pode fazer stake da sua própria carteira' });
        }
        if (!address || !amount) {
            return res.status(400).json({ success: false, error: 'Address e amount são obrigatórios' });
        }
        const result = blockchain.stake(address, parseFloat(amount));
        if (result.success) {
            res.json(result);
        } else {
            res.status(400).json(result);
        }
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/unstake', authenticate, (req, res) => {
    try {
        const { address, amount } = req.body;
        if (address !== req.user.address) {
            return res.status(403).json({ success: false, error: 'Você só pode fazer unstake da sua própria carteira' });
        }
        if (!address || !amount) {
            return res.status(400).json({ success: false, error: 'Address e amount são obrigatórios' });
        }
        const result = blockchain.unstake(address, parseFloat(amount));
        if (result.success) {
            res.json(result);
        } else {
            res.status(400).json(result);
        }
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/claim', authenticate, (req, res) => {
    try {
        const { address } = req.body;
        if (address !== req.user.address) {
            return res.status(403).json({ success: false, error: 'Você só pode reivindicar da sua própria carteira' });
        }
        if (!address) {
            return res.status(400).json({ success: false, error: 'Address é obrigatório' });
        }
        const result = blockchain.claimRewards(address);
        if (result.success) {
            res.json(result);
        } else {
            res.status(400).json(result);
        }
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================
// ENDPOINTS PÚBLICOS (sem autenticação)
// ============================================

// Mineração – agora usa o minerador configurado se address não for fornecido
app.post('/api/mine', (req, res) => {
    const { address } = req.body;
    const miner = address || config.minerAddress;
    if (blockchain.pending.length === 0) {
        return res.json({ success: false, message: 'Nenhuma transação pendente' });
    }
    const block = blockchain.minePending(miner);
    if (!block) {
        return res.json({ success: false, message: 'Falha na mineração' });
    }
    const coinbase = block.transactions[0];
    res.json({
        success: true,
        blockIndex: block.index,
        transactions: block.transactions.length,
        reward: coinbase.amount,
        miner: miner,
        baseReward: blockchain.calculateReward(block.index),
        totalFees: coinbase.amount - blockchain.calculateReward(block.index)
    });
});

// Saldo (público)
app.get('/api/balance/:address', (req, res) => {
    try {
        const { address } = req.params;
        const validation = validator.validateAddress(address);
        if (!validation.valid && !address.startsWith('Br')) {
            return res.status(400).json({ success: false, error: 'Formato de endereço inválido' });
        }
        const balance = blockchain.getBalance(address);
        const staking = blockchain.getStaking(address);
        const user = users.find(u => u.address === address);
        res.json({
            success: true,
            data: {
                address,
                username: user?.username || 'Unknown',
                balance,
                staked: staking.staked || 0,
                rewards: staking.rewards || 0,
                currency: config.coinSymbol,
                exists: true,
                formatted: `${balance.toLocaleString()} ${config.coinSymbol}`,
                decimals: config.decimals,
                addressFormat: user?.addressFormat || 'standard'
            }
        });
    } catch (error) {
        console.error('❌ Balance error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/users', (req, res) => {
    const userList = users.map(u => ({
        id: u.id,
        username: u.username,
        address: u.address,
        balance: blockchain.getBalance(u.address) || u.balance,
        formattedBalance: `${(blockchain.getBalance(u.address) || u.balance).toLocaleString()} ${config.coinSymbol}`,
        createdAt: u.createdAt,
        addressFormat: u.addressFormat || 'standard'
    }));
    res.json({
        success: true,
        data: {
            total: users.length,
            users: userList,
            currency: config.coinSymbol
        }
    });
});

app.get('/api/user/:username', (req, res) => {
    try {
        const { username } = req.params;
        const user = users.find(u => u.username === username);
        if (!user) {
            return res.status(404).json({ success: false, error: 'Usuário não encontrado' });
        }
        const balance = blockchain.getBalance(user.address);
        res.json({
            success: true,
            data: {
                username: user.username,
                address: user.address,
                balance,
                formattedBalance: `${balance.toLocaleString()} ${config.coinSymbol}`,
                createdAt: user.createdAt,
                addressFormat: user.addressFormat || 'standard'
            }
        });
    } catch (error) {
        console.error('❌ Get user error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/transactions/:address', (req, res) => {
    try {
        const { address } = req.params;
        const user = users.find(u => u.address === address);
        if (!user) {
            return res.status(404).json({ success: false, error: 'Endereço não encontrado' });
        }
        const txs = blockchain.history.filter(t => t.from === address || t.to === address).slice(-20).reverse();
        const formattedTxs = txs.length > 0 ? txs : [
            {
                id: hashManager.generateTxId({ type: 'genesis', address, timestamp: user.createdAt }),
                type: 'receive',
                from: 'Genesis Block',
                to: address,
                amount: user.balance,
                timestamp: user.createdAt,
                status: 'confirmed',
                hash: hashManager.hashTransaction({ type: 'genesis', address })
            }
        ];
        res.json({
            success: true,
            data: {
                address,
                username: user.username,
                totalTransactions: formattedTxs.length,
                transactions: formattedTxs,
                currency: config.coinSymbol
            }
        });
    } catch (error) {
        console.error('❌ Transactions error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/config', (req, res) => {
    res.json({
        success: true,
        data: {
            coinName: config.coinName,
            coinSymbol: config.coinSymbol,
            decimals: config.decimals,
            chainId: config.chainId,
            totalSupply: config.totalSupply,
            blockTime: config.blockTime,
            environment: config.nodeEnv,
            rpcUrl: config.rpcUrl,
            network: config.network,
            minerAddress: config.minerAddress, // NOVO
            modules: ['hash', 'checksum', 'validator', 'encoding', 'wallet', 'blockchain']
        }
    });
});

// ============================================
// WALLET ENDPOINTS (mantidos)
// ============================================
app.post('/api/wallet/create', (req, res) => {
    try {
        const result = wallet.createWallet();
        res.json({ success: true, data: result });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/wallet/verify', (req, res) => {
    try {
        const { address } = req.body;
        if (!address) return res.status(400).json({ success: false, error: 'Address is required' });
        const result = wallet.verifyAddress(address);
        res.json(result);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/wallet/wif', (req, res) => {
    try {
        const { privateKey, compressed = true } = req.body;
        if (!privateKey) return res.status(400).json({ success: false, error: 'Private key is required' });
        const result = wallet.generateWIF(privateKey, compressed);
        res.json(result);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/wallet/detect', (req, res) => {
    try {
        const { address } = req.body;
        if (!address) return res.status(400).json({ success: false, error: 'Address is required' });
        const result = wallet.detectAddressType(address);
        res.json(result);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/wallet/generate-keys', (req, res) => {
    try {
        const result = wallet.generateKeyPair();
        res.json({ success: true, data: result });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/wallet/import', (req, res) => {
    try {
        const { privateKey } = req.body;
        if (!privateKey) return res.status(400).json({ success: false, error: 'Private key is required' });
        const result = wallet.importWallet(privateKey);
        res.json(result);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/wallet/info', (req, res) => {
    try {
        const { address } = req.body;
        if (!address) return res.status(400).json({ success: false, error: 'Address is required' });
        const result = wallet.getWalletInfo(address);
        res.json(result);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/wallet/balance', (req, res) => {
    try {
        const { address } = req.body;
        if (!address) return res.status(400).json({ success: false, error: 'Address is required' });
        const balance = wallet.getBalance(address);
        res.json({ success: true, address, balance, currency: config.coinSymbol });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================
// HASH, CHECKSUM, ENCODING, VALIDATION ENDPOINTS (mantidos)
// ============================================
// (mantenha todos os endpoints /hash, /checksum, /encode, /validate como estavam)

// ============================================
// JSON-RPC ENDPOINT
// ============================================
app.post('/rpc', (req, res) => {
    try {
        const { jsonrpc, method, params, id } = req.body;
        if (jsonrpc !== '2.0') {
            return res.status(400).json({ jsonrpc: '2.0', error: { code: -32600, message: 'Invalid Request' }, id: id || null });
        }
        switch (method) {
            case 'eth_chainId':
                return res.json({ jsonrpc: '2.0', result: '0x' + config.chainId.toString(16), id });
            case 'net_version':
                return res.json({ jsonrpc: '2.0', result: String(config.chainId), id });
            case 'eth_blockNumber':
                return res.json({ jsonrpc: '2.0', result: '0x' + blockchain.chain.length.toString(16), id });
            case 'web3_clientVersion':
                return res.json({ jsonrpc: '2.0', result: `${config.coinName}/v2.0`, id });
            default:
                return res.json({ jsonrpc: '2.0', error: { code: -32601, message: 'Method not found' }, id });
        }
    } catch (error) {
        res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: error.message }, id: req.body?.id || null });
    }
});

// ============================================
// 404 HANDLER
// ============================================
app.use((req, res) => {
    res.status(404).json({ success: false, error: 'Route not found', path: req.url, method: req.method });
});

// ============================================
// ERROR HANDLER
// ============================================
app.use((err, req, res, next) => {
    console.error('❌ Unhandled error:', err);
    console.error('Stack:', err.stack);
    res.status(500).json({ success: false, error: err.message || 'Internal server error', timestamp: new Date().toISOString() });
});

// ============================================
// START SERVER
// ============================================
const server = app.listen(config.port, config.host, () => {
    console.log('\n🚀 ====================================');
    console.log(`   ✅ ${config.coinName} API v2.0 is running!`);
    console.log('   ====================================');
    console.log(`   📍 Port: ${config.port}`);
    console.log(`   🪙  Currency: ${config.coinSymbol}`);
    console.log(`   ⛓️  Chain ID: ${config.chainId}`);
    console.log(`   🌎 Environment: ${config.nodeEnv}`);
    console.log(`   🔗 Network: ${config.network}`);
    console.log(`   ⛏️  Miner Address: ${config.minerAddress}`); // NOVO
    console.log(`   🔗 URL: http://${config.host}:${config.port}`);
    console.log(`   📊 Users loaded: ${users.length}`);
    console.log(`   📦 Blockchain: ${blockchain.chain.length} blocks`);
    console.log('   ====================================');
    console.log('   🔐 CRYPTOGRAPHY MODULES:');
    console.log('   ✅ Hash Manager');
    console.log('   ✅ Checksum Manager');
    console.log('   ✅ Validator');
    console.log('   ✅ Encoding');
    console.log('   ✅ Wallet');
    console.log('   ✅ Blockchain Engine (with HALVING!)');
    console.log('   ====================================');
    console.log('   📚 ROUTES:');
    console.log('   GET  /explorer              - Block explorer (HTML)');
    console.log('   GET  /explorer/transactions - Transactions list (HTML)');
    console.log('   GET  /explorer/stats        - Network stats (HTML)');
    console.log('   GET  /miner                 - Miner address (JSON)');
    console.log('   GET  /block/:index          - Block details (JSON)');
    console.log('   POST /api/register          - Register new user (returns JWT)');
    console.log('   POST /api/login             - Login (returns JWT)');
    console.log('   POST /api/mine              - Mine pending transactions');
    console.log('   POST /api/send              - Send BRD (requires JWT)');
    console.log('   POST /api/stake             - Stake BRD (requires JWT)');
    console.log('   POST /api/unstake           - Unstake BRD (requires JWT)');
    console.log('   POST /api/claim             - Claim staking rewards (requires JWT)');
    console.log('   GET  /api/balance/:address  - Check balance');
    console.log('   GET  /api/users             - List all users');
    console.log('   GET  /api/user/:username    - Get user by username');
    console.log('   GET  /api/transactions/:address - Transaction history');
    console.log('   POST /rpc                   - JSON-RPC endpoint');
    console.log('   ====================================\n');
});

// ============================================
// GRACEFUL SHUTDOWN
// ============================================
process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down gracefully...');
    blockchain.saveToDisk();
    saveUsers(users);
    server.close(() => {
        console.log('✅ Server closed');
        process.exit(0);
    });
});

process.on('SIGTERM', () => {
    console.log('\n🛑 Shutting down gracefully...');
    blockchain.saveToDisk();
    saveUsers(users);
    server.close(() => {
        console.log('✅ Server closed');
        process.exit(0);
    });
});

module.exports = { app, config, users, saveUsers, blockchain };
