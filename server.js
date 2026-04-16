const express = require('express');
const cors = require('cors');
const Blockchain = require('./blockchain');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Initialize blockchain
const bradicoin = new Blockchain();

// ========== API ENDPOINTS ==========

// Root endpoint
app.get('/', (req, res) => {
    res.json({
        name: 'Bradicoin API',
        version: '1.0.0',
        description: 'Blockchain API for Bradicoin cryptocurrency',
        endpoints: {
            blockchain: '/api/blockchain',
            block: '/api/block/:index',
            latestBlock: '/api/block/latest',
            transactions: '/api/transactions',
            transaction: '/api/transaction',
            mine: '/api/mine',
            balance: '/api/balance/:address',
            validate: '/api/validate',
            info: '/api/info',
            pending: '/api/pending',
            difficulty: '/api/difficulty',
            reward: '/api/reward'
        }
    });
});

// 1. Get complete blockchain
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

// 2. Get block by index
app.get('/api/block/:index', (req, res) => {
    try {
        const index = parseInt(req.params.index);
        const block = bradicoin.getBlockByIndex(index);
        
        if (block) {
            res.json({ success: true, data: block });
        } else {
            res.status(404).json({ 
                success: false, 
                error: `Block with index ${index} not found` 
            });
        }
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 3. Get latest block
app.get('/api/block/latest', (req, res) => {
    try {
        const latestBlock = bradicoin.getLatestBlockInfo();
        res.json({ success: true, data: latestBlock });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 4. Get all transactions for an address
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

// 5. Create new transaction
app.post('/api/transaction', (req, res) => {
    try {
        const { fromAddress, toAddress, amount } = req.body;
        
        // Validate required fields
        if (!toAddress || !amount) {
            return res.status(400).json({
                success: false,
                error: 'Missing required fields: toAddress and amount are required'
            });
        }
        
        // Validate amount
        if (amount <= 0) {
            return res.status(400).json({
                success: false,
                error: 'Amount must be greater than 0'
            });
        }
        
        // Check if sender has sufficient balance (only if fromAddress is provided)
        if (fromAddress) {
            const balance = bradicoin.getBalance(fromAddress);
            if (balance < amount) {
                return res.status(400).json({
                    success: false,
                    error: 'Insufficient balance',
                    balance: balance,
                    requestedAmount: amount
                });
            }
        }
        
        const transaction = {
            fromAddress: fromAddress || null,
            toAddress,
            amount: parseFloat(amount),
            timestamp: new Date().toISOString()
        };
        
        const transactionIndex = bradicoin.addTransaction(transaction);
        
        res.json({
            success: true,
            message: 'Transaction added successfully',
            data: {
                transaction,
                pendingIndex: transactionIndex,
                pendingTransactionsCount: bradicoin.getPendingTransactions().length
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 6. Mine pending transactions
app.get('/api/mine', (req, res) => {
    try {
        const minerAddress = req.query.address || 'miner-default-address';
        
        if (bradicoin.pendingTransactions.length === 0) {
            return res.json({
                success: true,
                message: 'No pending transactions to mine',
                data: {
                    mined: false,
                    pendingTransactions: 0
                }
            });
        }
        
        const newBlock = bradicoin.minePendingTransactions(minerAddress);
        
        res.json({
            success: true,
            message: 'Block mined successfully!',
            data: {
                mined: true,
                block: newBlock,
                reward: bradicoin.miningReward,
                minerAddress: minerAddress,
                totalBlocks: bradicoin.chain.length
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 7. Get balance for address
app.get('/api/balance/:address', (req, res) => {
    try {
        const address = req.params.address;
        const balance = bradicoin.getBalance(address);
        
        res.json({
            success: true,
            data: {
                address,
                balance,
                currency: 'Bradicoins',
                symbol: 'BRC'
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 8. Validate blockchain integrity
app.get('/api/validate', (req, res) => {
    try {
        const isValid = bradicoin.isChainValid();
        
        res.json({
            success: true,
            data: {
                isValid: isValid,
                message: isValid ? 'Blockchain is valid and intact!' : 'Blockchain has been compromised!',
                blocksChecked: bradicoin.chain.length
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 9. Get blockchain info
app.get('/api/info', (req, res) => {
    try {
        const info = bradicoin.getChainInfo();
        
        res.json({
            success: true,
            data: info
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 10. Get pending transactions
app.get('/api/pending', (req, res) => {
    try {
        const pending = bradicoin.getPendingTransactions();
        
        res.json({
            success: true,
            data: {
                count: pending.length,
                transactions: pending
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 11. Update mining difficulty (admin only - no auth for demo)
app.put('/api/difficulty', (req, res) => {
    try {
        const { difficulty } = req.body;
        
        if (!difficulty) {
            return res.status(400).json({
                success: false,
                error: 'Difficulty value is required'
            });
        }
        
        const result = bradicoin.updateDifficulty(parseInt(difficulty));
        
        res.json({
            success: true,
            data: result
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 12. Update mining reward (admin only - no auth for demo)
app.put('/api/reward', (req, res) => {
    try {
        const { reward } = req.body;
        
        if (!reward) {
            return res.status(400).json({
                success: false,
                error: 'Reward value is required'
            });
        }
        
        const result = bradicoin.updateMiningReward(parseFloat(reward));
        
        res.json({
            success: true,
            data: result
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 13. Clear pending transactions (admin only - use with caution)
app.delete('/api/pending', (req, res) => {
    try {
        const result = bradicoin.clearPendingTransactions();
        
        res.json({
            success: true,
            message: 'Pending transactions cleared',
            data: result
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 14. Get all transactions (paginated)
app.get('/api/transactions', (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 50;
        const offset = parseInt(req.query.offset) || 0;
        
        const allTransactions = [];
        
        for (const block of bradicoin.chain) {
            if (block.transactions && Array.isArray(block.transactions)) {
                for (const transaction of block.transactions) {
                    if (transaction !== 'Genesis Block - Bradicoin') {
                        allTransactions.push({
                            ...transaction,
                            blockIndex: block.index,
                            blockHash: block.hash
                        });
                    }
                }
            }
        }
        
        const paginatedTransactions = allTransactions.slice(offset, offset + limit);
        
        res.json({
            success: true,
            data: {
                total: allTransactions.length,
                limit,
                offset,
                transactions: paginatedTransactions
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 404 handler for undefined routes
app.use((req, res) => {
    res.status(404).json({
        success: false,
        error: 'Route not found',
        message: `Cannot ${req.method} ${req.url}`
    });
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({
        success: false,
        error: 'Internal server error',
        message: err.message
    });
});

// Start server
app.listen(PORT, () => {
    console.log(`🚀 Bradicoin API is running!`);
    console.log(`📡 Server: http://localhost:${PORT}`);
    console.log(`💎 Blockchain initialized with ${bradicoin.chain.length} block(s)`);
    console.log(`⚙️ Mining difficulty: ${bradicoin.difficulty}`);
    console.log(`💰 Mining reward: ${bradicoin.miningReward} BRC`);
    console.log(`📝 API endpoints available at http://localhost:${PORT}/`);
});
