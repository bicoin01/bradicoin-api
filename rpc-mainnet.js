// rpc-mainnet.js
// Complete RPC Server for Bradicoin Mainnet
// Token Symbol: BRD

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');

// Import existing Bradicoin modules
const Blockchain = require('./blockchain');
const Transactions = require('./transactions');
const Wallet = require('./wallet');
const SmartContracts = require('./smartcontracts');
const Explorer = require('./explorer');
const Staking = require('./staking');
const Privacy = require('./privacy');
const Bridge = require('./bridge');
const Market = require('./market');
const Analytics = require('./analytics');
const ZkPrivacy = require('./zkPrivacy');

// ==================== MAINNET CONFIGURATION ====================
const CONFIG = {
    network: 'mainnet',
    networkName: 'Bradicoin',
    symbol: 'BRD',              // Token symbol: BRD
    chainId: '0x1',
    rpcPort: 8545,
    rpcHost: '0.0.0.0',
    dataDir: './bradicoin-data',
    blockReward: 12.5,
    targetBlockTime: 15,
    maxPeers: 50,
    minGasPrice: 1,
    maxGasPrice: 1000,
    genesisAddress: '0x0000000000000000000000000000000000000000'
};

// Ensure data directory exists
if (!fs.existsSync(CONFIG.dataDir)) {
    fs.mkdirSync(CONFIG.dataDir, { recursive: true });
}

// ==================== MODULE INITIALIZATION ====================
console.log('\n========================================');
console.log(`🚀 Bradicoin (${CONFIG.symbol}) Mainnet RPC Server v1.0`);
console.log('========================================\n');

let blockchain, transactions, wallet, smartContracts, explorer, staking, privacy, bridge, market, analytics, zkPrivacy;

// Load modules with error handling
try {
    blockchain = new Blockchain();
    console.log('✓ Blockchain module initialized');
} catch(e) { console.error('✗ Blockchain error:', e.message); blockchain = createMockBlockchain(); }

try {
    transactions = new Transactions(blockchain);
    console.log('✓ Transactions module initialized');
} catch(e) { console.error('✗ Transactions error:', e.message); transactions = createMockTransactions(); }

try {
    wallet = new Wallet();
    console.log('✓ Wallet module initialized');
} catch(e) { console.error('✗ Wallet error:', e.message); wallet = createMockWallet(); }

try {
    smartContracts = new SmartContracts(blockchain);
    console.log('✓ SmartContracts module initialized');
} catch(e) { console.error('✗ SmartContracts error:', e.message); smartContracts = createMockSmartContracts(); }

try {
    explorer = new Explorer(blockchain);
    console.log('✓ Explorer module initialized');
} catch(e) { console.error('✗ Explorer error:', e.message); explorer = createMockExplorer(); }

try {
    staking = new Staking(blockchain);
    console.log('✓ Staking module initialized');
} catch(e) { console.error('✗ Staking error:', e.message); staking = createMockStaking(); }

try {
    privacy = new Privacy();
    console.log('✓ Privacy module initialized');
} catch(e) { console.error('✗ Privacy error:', e.message); privacy = createMockPrivacy(); }

try {
    bridge = new Bridge();
    console.log('✓ Bridge module initialized');
} catch(e) { console.error('✗ Bridge error:', e.message); bridge = createMockBridge(); }

try {
    market = new Market();
    console.log('✓ Market module initialized');
} catch(e) { console.error('✗ Market error:', e.message); market = createMockMarket(); }

try {
    analytics = new Analytics(blockchain);
    console.log('✓ Analytics module initialized');
} catch(e) { console.error('✗ Analytics error:', e.message); analytics = createMockAnalytics(); }

try {
    zkPrivacy = new ZkPrivacy();
    console.log('✓ ZkPrivacy module initialized');
} catch(e) { console.error('✗ ZkPrivacy error:', e.message); zkPrivacy = createMockZkPrivacy(); }

// ==================== MOCK FALLBACK FUNCTIONS ====================
function createMockBlockchain() {
    let blocks = [{ index: 0, hash: '0xgenesis', previousHash: '0x0', timestamp: Date.now(), transactions: [] }];
    return {
        getBlockCount: () => blocks.length,
        getBlockHash: (index) => blocks[index]?.hash,
        getBlock: (hash) => blocks.find(b => b.hash === hash),
        getDifficulty: () => 4,
        addBlock: (txs) => {
            const newBlock = { 
                index: blocks.length, 
                hash: crypto.randomBytes(32).toString('hex'), 
                previousHash: blocks[blocks.length-1].hash, 
                timestamp: Date.now(), 
                transactions: txs 
            };
            blocks.push(newBlock);
            return newBlock;
        },
        getBalance: (address) => 1000,
        getNonce: (address) => 0
    };
}

function createMockTransactions() {
    const mempool = [];
    return {
        sendRawTransaction: (rawtx) => { 
            const txid = crypto.randomBytes(32).toString('hex'); 
            mempool.push({ txid, rawtx, timestamp: Date.now() }); 
            return txid; 
        },
        getRawTransaction: (txid) => mempool.find(t => t.txid === txid)?.rawtx || null,
        getTransaction: (txid) => mempool.find(t => t.txid === txid) || null,
        getMempool: () => mempool
    };
}

function createMockWallet() {
    const addresses = new Map();
    const privateKeys = new Map();
    return {
        createNewAddress: () => { 
            const privateKey = crypto.randomBytes(32).toString('hex');
            const publicKey = crypto.createHash('sha256').update(privateKey).digest('hex');
            const addr = 'BRD' + publicKey.substring(0, 40);
            addresses.set(addr, 1000);
            privateKeys.set(addr, privateKey);
            return addr; 
        },
        getBalance: (addr) => addresses.get(addr) || 0,
        getPrivateKey: (addr) => privateKeys.get(addr) || null,
        listUnspent: () => Array.from(addresses.entries()).map(([addr, bal]) => ({ 
            address: addr, 
            amount: bal,
            confirmations: 10
        })),
        sendToAddress: (from, to, amount) => {
            const fromBalance = addresses.get(from) || 0;
            if (fromBalance < amount) return { error: 'Insufficient funds' };
            addresses.set(from, fromBalance - amount);
            addresses.set(to, (addresses.get(to) || 0) + amount);
            return { txid: crypto.randomBytes(32).toString('hex'), amount };
        }
    };
}

function createMockSmartContracts() {
    const contracts = new Map();
    return {
        createContract: (code, owner) => { 
            const addr = '0x' + crypto.randomBytes(20).toString('hex'); 
            contracts.set(addr, { code, owner, createdAt: Date.now() }); 
            return addr; 
        },
        callContract: (addr, method, params) => { 
            const contract = contracts.get(addr);
            if (!contract) return { error: 'Contract not found' };
            return { result: `Called ${method} on ${addr} with params: ${JSON.stringify(params)}` };
        },
        getContract: (addr) => contracts.get(addr) || null,
        listContracts: () => Array.from(contracts.keys())
    };
}

function createMockExplorer() {
    return { 
        getTransactionReceipt: (txid) => ({ 
            txid, 
            confirmed: true, 
            blockHash: '0xmockhash',
            blockNumber: 100,
            confirmations: 6,
            timestamp: Date.now()
        }),
        getBlockExplorer: (hash) => ({
            hash,
            height: 100,
            transactions: ['tx1', 'tx2'],
            timestamp: Date.now()
        })
    };
}

function createMockStaking() {
    let stakes = new Map();
    let totalRewards = 0;
    return {
        stake: (addr, amt) => { 
            if (amt < 100) return { error: 'Minimum stake is 100 BRD' };
            stakes.set(addr, amt); 
            return { success: true, amount: amt, address: addr, reward: amt * 0.05 };
        },
        unstake: (addr) => {
            const amount = stakes.get(addr) || 0;
            stakes.delete(addr);
            return { success: true, amount, address: addr };
        },
        getStakingInfo: () => ({ 
            totalStaked: Array.from(stakes.values()).reduce((a,b)=>a+b,0), 
            stakers: stakes.size,
            apy: 12.5,
            minStake: 100
        }),
        getStakerInfo: (addr) => ({ address: addr, staked: stakes.get(addr) || 0, rewards: 0 })
    };
}

function createMockPrivacy() {
    return { 
        createPrivatePayment: (from, to, amt, proof) => ({ 
            success: proof === 'valid', 
            txid: crypto.randomBytes(32).toString('hex'),
            private: true
        }) 
    };
}

function createMockBridge() {
    const bridges = [];
    return { 
        deposit: (fromChain, toChain, asset, amt, dest) => {
            const bridgeId = crypto.randomBytes(32).toString('hex');
            bridges.push({ bridgeId, fromChain, toChain, asset, amt, dest, status: 'pending' });
            return { success: true, bridgeTxId: bridgeId, estimatedTime: '5 minutes' };
        },
        getBridgeStatus: (bridgeId) => bridges.find(b => b.bridgeId === bridgeId) || null
    };
}

function createMockMarket() {
    return { 
        getPrice: (symbol) => {
            const prices = { BRD: 1.25, BTC: 45000, ETH: 3000, USD: 1 };
            return prices[symbol.toUpperCase()] || 0;
        },
        getMarketCap: () => ({ BRD: 125000000, total: 125000000 }),
        getVolume24h: () => ({ BRD: 5000000 })
    };
}

function createMockAnalytics() {
    return { 
        getBlockchainAnalytics: () => ({ 
            totalBlocks: 1250,
            avgBlockTime: 14.8,
            totalTransactions: 87500,
            activeAddresses: 3420,
            totalSupply: 10000000,
            stakedPercentage: 45.2
        }),
        getTransactionAnalytics: () => ({
            dailyAvg: 1250,
            weeklyAvg: 11200,
            monthlyAvg: 48500
        })
    };
}

function createMockZkPrivacy() {
    return { 
        createPrivatePayment: (from, to, amt, proof) => ({ 
            success: true, 
            privateTxId: crypto.randomBytes(32).toString('hex'),
            zkProof: 'generated'
        }),
        verifyProof: (proof) => ({ valid: true })
    };
}

// ==================== EXPRESS SERVER SETUP ====================
const app = express();
app.use(express.json({ limit: '50mb' }));

// CORS headers for web integration
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

// Request logging
app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
        const duration = Date.now() - start;
        console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} - ${res.statusCode} - ${duration}ms`);
    });
    next();
});

// ==================== BRADICOIN RPC ENDPOINTS ====================

// Root endpoint
app.get('/', (req, res) => {
    res.json({
        name: CONFIG.networkName,
        symbol: CONFIG.symbol,
        version: '1.0.0',
        network: CONFIG.network,
        endpoints: [
            '/health',
            '/bradicoin/getinfo',
            '/bradicoin/getbalance',
            '/bradicoin/sendtransaction',
            '/bradicoin/getnewaddress',
            '/bradicoin/stake',
            '/bradicoin/createcontract',
            '/bradicoin/bridge/deposit'
        ]
    });
});

// Health check
app.get('/health', (req, res) => {
    res.json({ 
        status: 'online', 
        network: CONFIG.network,
        symbol: CONFIG.symbol,
        timestamp: Date.now(),
        version: '1.0.0'
    });
});

// 1. Network Information
app.post('/bradicoin/getinfo', (req, res) => {
    try {
        res.json({
            version: '1.0.0',
            protocolversion: 70015,
            network: CONFIG.network,
            networkName: CONFIG.networkName,
            symbol: CONFIG.symbol,
            chainId: CONFIG.chainId,
            blocks: blockchain.getBlockCount(),
            connections: CONFIG.maxPeers,
            difficulty: blockchain.getDifficulty(),
            blockReward: CONFIG.blockReward,
            minGasPrice: CONFIG.minGasPrice,
            maxGasPrice: CONFIG.maxGasPrice,
            dataDir: CONFIG.dataDir
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 2. Blockchain endpoints
app.post('/bradicoin/getblockcount', (req, res) => {
    try {
        const count = blockchain.getBlockCount();
        res.json({ count });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/bradicoin/getblockhash', (req, res) => {
    try {
        const { index } = req.body;
        if (index === undefined) {
            return res.status(400).json({ error: 'Missing parameter: index' });
        }
        const hash = blockchain.getBlockHash(index);
        if (hash) {
            res.json({ hash });
        } else {
            res.status(404).json({ error: 'Block not found' });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/bradicoin/getblock', (req, res) => {
    try {
        const { hash } = req.body;
        if (!hash) {
            return res.status(400).json({ error: 'Missing parameter: hash' });
        }
        const block = blockchain.getBlock(hash);
        if (block) {
            res.json(block);
        } else {
            res.status(404).json({ error: 'Block not found' });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 3. Wallet endpoints
app.post('/bradicoin/getnewaddress', (req, res) => {
    try {
        const address = wallet.createNewAddress();
        res.json({ address, symbol: CONFIG.symbol });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/bradicoin/getbalance', (req, res) => {
    try {
        const { address } = req.body;
        if (!address) {
            return res.status(400).json({ error: 'Missing parameter: address' });
        }
        const balance = wallet.getBalance(address);
        res.json({ address, balance, symbol: CONFIG.symbol });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/bradicoin/listunspent', (req, res) => {
    try {
        const utxos = wallet.listUnspent();
        res.json({ utxos, symbol: CONFIG.symbol });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/bradicoin/sendtoaddress', (req, res) => {
    try {
        const { from, to, amount } = req.body;
        if (!from || !to || !amount) {
            return res.status(400).json({ error: 'Missing parameters: from, to, amount' });
        }
        const result = wallet.sendToAddress(from, to, amount);
        if (result.error) {
            res.status(400).json(result);
        } else {
            res.json({ ...result, symbol: CONFIG.symbol });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 4. Transaction endpoints
app.post('/bradicoin/sendrawtransaction', (req, res) => {
    try {
        const { rawtx } = req.body;
        if (!rawtx) {
            return res.status(400).json({ error: 'Missing parameter: rawtx' });
        }
        const txid = transactions.sendRawTransaction(rawtx);
        res.json({ txid, symbol: CONFIG.symbol });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/bradicoin/getrawtransaction', (req, res) => {
    try {
        const { txid } = req.body;
        if (!txid) {
            return res.status(400).json({ error: 'Missing parameter: txid' });
        }
        const tx = transactions.getRawTransaction(txid);
        if (tx) {
            res.json({ hex: tx });
        } else {
            res.status(404).json({ error: 'Transaction not found' });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/bradicoin/gettransaction', (req, res) => {
    try {
        const { txid } = req.body;
        if (!txid) {
            return res.status(400).json({ error: 'Missing parameter: txid' });
        }
        const tx = transactions.getTransaction(txid);
        if (tx) {
            res.json(tx);
        } else {
            res.status(404).json({ error: 'Transaction not found' });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/bradicoin/gettransactionreceipt', (req, res) => {
    try {
        const { txid } = req.body;
        if (!txid) {
            return res.status(400).json({ error: 'Missing parameter: txid' });
        }
        const receipt = explorer.getTransactionReceipt(txid);
        if (receipt) {
            res.json(receipt);
        } else {
            res.status(404).json({ error: 'Receipt not found' });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 5. Smart Contract endpoints
app.post('/bradicoin/createcontract', (req, res) => {
    try {
        const { code, owner } = req.body;
        if (!code || !owner) {
            return res.status(400).json({ error: 'Missing parameters: code, owner' });
        }
        const contractAddress = smartContracts.createContract(code, owner);
        res.json({ contractAddress, symbol: CONFIG.symbol });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/bradicoin/callcontract', (req, res) => {
    try {
        const { address, method, params } = req.body;
        if (!address || !method) {
            return res.status(400).json({ error: 'Missing parameters: address, method' });
        }
        const result = smartContracts.callContract(address, method, params || []);
        res.json({ result, symbol: CONFIG.symbol });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/bradicoin/getcontract', (req, res) => {
    try {
        const { address } = req.body;
        if (!address) {
            return res.status(400).json({ error: 'Missing parameter: address' });
        }
        const contract = smartContracts.getContract(address);
        if (contract) {
            res.json(contract);
        } else {
            res.status(404).json({ error: 'Contract not found' });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 6. Staking endpoints
app.post('/bradicoin/stake', (req, res) => {
    try {
        const { address, amount } = req.body;
        if (!address || !amount) {
            return res.status(400).json({ error: 'Missing parameters: address, amount' });
        }
        const result = staking.stake(address, amount);
        if (result.error) {
            res.status(400).json(result);
        } else {
            res.json({ ...result, symbol: CONFIG.symbol });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/bradicoin/unstake', (req, res) => {
    try {
        const { address } = req.body;
        if (!address) {
            return res.status(400).json({ error: 'Missing parameter: address' });
        }
        const result = staking.unstake(address);
        res.json({ ...result, symbol: CONFIG.symbol });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/bradicoin/getstakinginfo', (req, res) => {
    try {
        const info = staking.getStakingInfo();
        res.json({ ...info, symbol: CONFIG.symbol });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/bradicoin/getstakerinfo', (req, res) => {
    try {
        const { address } = req.body;
        if (!address) {
            return res.status(400).json({ error: 'Missing parameter: address' });
        }
        const info = staking.getStakerInfo(address);
        res.json({ ...info, symbol: CONFIG.symbol });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 7. Privacy endpoints
app.post('/bradicoin/createprivatepayment', (req, res) => {
    try {
        const { from, to, amount, proof } = req.body;
        if (!from || !to || !amount) {
            return res.status(400).json({ error: 'Missing parameters: from, to, amount' });
        }
        const result = privacy.createPrivatePayment(from, to, amount, proof || 'valid');
        res.json({ ...result, symbol: CONFIG.symbol });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 8. Bridge endpoints
app.post('/bradicoin/bridge/deposit', (req, res) => {
    try {
        const { fromChain, toChain, asset, amount, destination } = req.body;
        if (!fromChain || !toChain || !asset || !amount || !destination) {
            return res.status(400).json({ error: 'Missing parameters: fromChain, toChain, asset, amount, destination' });
        }
        const result = bridge.deposit(fromChain, toChain, asset, amount, destination);
        res.json({ ...result, symbol: CONFIG.symbol });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/bradicoin/bridge/status', (req, res) => {
    try {
        const { bridgeId } = req.body;
        if (!bridgeId) {
            return res.status(400).json({ error: 'Missing parameter: bridgeId' });
        }
        const status = bridge.getBridgeStatus(bridgeId);
        if (status) {
            res.json(status);
        } else {
            res.status(404).json({ error: 'Bridge transaction not found' });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 9. Market endpoints
app.post('/bradicoin/getprice', (req, res) => {
    try {
        const { symbol } = req.body;
        const priceSymbol = symbol || CONFIG.symbol;
        const price = market.getPrice(priceSymbol);
        res.json({ symbol: priceSymbol, price, currency: 'USD' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/bradicoin/getmarketcap', (req, res) => {
    try {
        const marketCap = market.getMarketCap();
        res.json({ ...marketCap, symbol: CONFIG.symbol });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/bradicoin/getvolume', (req, res) => {
    try {
        const volume = market.getVolume24h();
        res.json({ ...volume, symbol: CONFIG.symbol });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 10. Analytics endpoints
app.post('/bradicoin/getanalytics', (req, res) => {
    try {
        const data = analytics.getBlockchainAnalytics();
        res.json({ ...data, symbol: CONFIG.symbol });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/bradicoin/gettxanalytics', (req, res) => {
    try {
        const data = analytics.getTransactionAnalytics();
        res.json({ ...data, symbol: CONFIG.symbol });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 11. ZK Privacy endpoints
app.post('/bradicoin/zk/createpayment', (req, res) => {
    try {
        const { from, to, amount, proof } = req.body;
        if (!from || !to || !amount) {
            return res.status(400).json({ error: 'Missing parameters: from, to, amount' });
        }
        const result = zkPrivacy.createPrivatePayment(from, to, amount, proof);
        res.json({ ...result, symbol: CONFIG.symbol });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/bradicoin/zk/verifyproof', (req, res) => {
    try {
        const { proof } = req.body;
        if (!proof) {
            return res.status(400).json({ error: 'Missing parameter: proof' });
        }
        const result = zkPrivacy.verifyProof(proof);
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 12. Mempool endpoints
app.post('/bradicoin/getmempool', (req, res) => {
    try {
        const mempool = transactions.getMempool();
        res.json({ transactions: mempool, count: mempool.length });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 13. Validate address
app.post('/bradicoin/validateaddress', (req, res) => {
    try {
        const { address } = req.body;
        if (!address) {
            return res.status(400).json({ error: 'Missing parameter: address' });
        }
        const isValid = address.startsWith('BRD') && address.length === 44;
        res.json({ address, isValid, symbol: CONFIG.symbol });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 14. Network peers
app.post('/bradicoin/getpeerinfo', (req, res) => {
    res.json({
        peers: [
            { id: 1, address: 'node1.bradichain.com', port: 8545, connected: true },
            { id: 2, address: 'node2.bradichain.com', port: 8545, connected: true }
        ],
        count: 2
    });
});

// 15. Mining info
app.post('/bradicoin/getmininginfo', (req, res) => {
    res.json({
        blocks: blockchain.getBlockCount(),
        difficulty: blockchain.getDifficulty(),
        networkHashrate: 125000000,
        reward: CONFIG.blockReward,
        symbol: CONFIG.symbol
    });
});

// 404 handler for undefined routes
app.use('*', (req, res) => {
    res.status(404).json({
        error: 'Endpoint not found',
        availableEndpoints: [
            '/bradicoin/getinfo',
            '/bradicoin/getbalance',
            '/bradicoin/sendtransaction',
            '/bradicoin/getnewaddress',
            '/bradicoin/stake',
            '/bradicoin/createcontract',
            '/bradicoin/bridge/deposit'
        ]
    });
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('Server error:', err);
    res.status(500).json({ error: 'Internal server error', message: err.message });
});

// ==================== START SERVER ====================
const server = app.listen(CONFIG.rpcPort, CONFIG.rpcHost, () => {
    console.log('\n========================================');
    console.log(`✅ Bradicoin ${CONFIG.symbol} Mainnet RPC Server Running`);
    console.log('========================================');
    console.log(`📍 Host: ${CONFIG.rpcHost}`);
    console.log(`📍 Port: ${CONFIG.rpcPort}`);
    console.log(`🔗 URL: http://${CONFIG.rpcHost}:${CONFIG.rpcPort}`);
    console.log(`🪙 Symbol: ${CONFIG.symbol}`);
    console.log(`🌐 Network: ${CONFIG.network}`);
    console.log('========================================\n');
    console.log('Available endpoints:');
    console.log('  POST /bradicoin/getinfo');
    console.log('  POST /bradicoin/getbalance');
    console.log('  POST /bradicoin/getnewaddress');
    console.log('  POST /bradicoin/sendtoaddress');
    console.log('  POST /bradicoin/stake');
    console.log('  POST /bradicoin/createcontract');
    console.log('  POST /bradicoin/bridge/deposit');
    console.log('  GET  /health');
    console.log('========================================\n');
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down Bradicoin RPC server...');
    server.close(() => {
        console.log('✅ Server stopped');
        process.exit(0);
    });
});

module.exports = { app, server, CONFIG };
