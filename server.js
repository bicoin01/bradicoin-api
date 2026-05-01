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

// ========== INTEGRATION: WALLET GENERATOR & RESERVE FUND ==========

// Helper function to load wallets from file
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

// Helper function to save wallets to file
function saveWallets(wallets) {
    try {
        fs.writeFileSync(WALLETS_FILE, JSON.stringify(wallets, null, 2));
        return true;
    } catch (e) {
        console.error('Error saving wallets:', e);
        return false;
    }
}

// Helper function to generate seed phrase (12 words)
function generateSeedPhrase() {
    const wordList = [
        "abandon", "ability", "able", "about", "above", "absent", "absorb", "abstract", "absurd", "abuse",
        "access", "accident", "account", "accuse", "achieve", "acid", "acoustic", "acquire", "across", "act",
        "action", "actor", "actress", "actual", "adapt", "add", "addict", "address", "adjust", "admit",
        "adult", "advance", "advice", "aerobic", "affair", "afford", "afraid", "africa", "after", "again",
        "age", "agent", "agree", "ahead", "aim", "air", "airport", "aisle", "alarm", "album", "alcohol"
    ];
    const words = [];
    for (let i = 0; i < 12; i++) {
        words.push(wordList[Math.floor(Math.random() * wordList.length)]);
    }
    return words.join(' ');
}

// Helper function to generate BRD wallet address
function generateWalletAddress(username, seed) {
    const hash = (seed + username + Date.now()).substring(0, 32);
    const randomPart = Math.random().toString(36).substring(2, 24);
    return `Br${hash}${randomPart}`;
}

// ========== NEW ENDPOINTS FOR WALLET GENERATOR & RESERVE FUND ==========

// 1. Register new wallet with seed phrase and initial balance
app.post('/api/wallet/register', (req, res) => {
    try {
        const { username, password } = req.body;
        
        if (!username || !password) {
            return res.status(400).json({
                success: false,
                error: 'Username and password are required'
            });
        }
        
        if (username.length < 3 || password.length < 4) {
            return res.status(400).json({
                success: false,
                error: 'Username (min 3 chars) and password (min 4 chars) required'
            });
        }
        
        // Load existing wallets
        let wallets = loadWallets();
        
        // Check if username already exists
        if (wallets.find(w => w.username === username)) {
            return res.status(400).json({
                success: false,
                error: 'Username already exists'
            });
        }
        
        // Check registration limit (max 3 users)
        if (wallets.length >= 3) {
            return res.status(403).json({
                success: false,
                error: 'Registration limit reached. Maximum 3 users allowed.'
            });
        }
        
        // Generate seed phrase and wallet address
        const seedPhrase = generateSeedPhrase();
        const walletAddress = generateWalletAddress(username, seedPhrase);
        const RESERVE_TOTAL_SUPPLY = 99999999999999999;
        
        // Create new wallet
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
        
        // Add genesis transaction to blockchain (optional)
        const genesisTransaction = {
            fromAddress: null,
            toAddress: walletAddress,
            amount: RESERVE_TOTAL_SUPPLY,
            timestamp: new Date().toISOString(),
            type: 'GENESIS'
        };
        bradicoin.addTransaction(genesisTransaction);
        
        res.json({
            success: true,
            message: `Wallet created successfully! Balance: ${RESERVE_TOTAL_SUPPLY.toLocaleString()} BRD`,
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

// 2. Login and get wallet info
app.post('/api/wallet/login', (req, res) => {
    try {
        const { username, password } = req.body;
        
        if (!username || !password) {
            return res.status(400).json({
                success: false,
                error: 'Username and password are required'
            });
        }
        
        const wallets = loadWallets();
        const wallet = wallets.find(w => w.username === username && w.password === password);
        
        if (!wallet) {
            return res.status(401).json({
                success: false,
                error: 'Invalid username or password'
            });
        }
        
        res.json({
            success: true,
            data: {
                id: wallet.id,
                username: wallet.username,
                address: wallet.address,
                seedPhrase: wallet.seedPhrase,
                balance: bradicoin.getBalance(wallet.address),
                createdAt: wallet.createdAt
            }
        });
        
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 3. Get wallet details by address
app.get('/api/wallet/:address', (req, res) => {
    try {
        const { address } = req.params;
        const wallets = loadWallets();
        const wallet = wallets.find(w => w.address === address);
        
        if (!wallet) {
            return res.status(404).json({
                success: false,
                error: 'Wallet not found'
            });
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

// 4. Send BRD to another wallet (with auto-repletion from reserve fund)
app.post('/api/wallet/send', (req, res) => {
    try {
        const { fromAddress, toAddress, amount, privateKey } = req.body;
        
        if (!fromAddress || !toAddress || !amount) {
            return res.status(400).json({
                success: false,
                error: 'fromAddress, toAddress and amount are required'
            });
        }
        
        if (amount <= 0) {
            return res.status(400).json({
                success: false,
                error: 'Amount must be greater than 0'
            });
        }
        
        // Get wallets
        let wallets = loadWallets();
        const fromWallet = wallets.find(w => w.address === fromAddress);
        
        if (!fromWallet) {
            return res.status(404).json({
                success: false,
                error: 'Sender wallet not found'
            });
        }
        
        // Check balance
        const currentBalance = bradicoin.getBalance(fromAddress);
        if (currentBalance < amount) {
            return res.status(400).json({
                success: false,
                error: 'Insufficient balance',
                balance: currentBalance,
                requested: amount
            });
        }
        
        // Get or create destination wallet
        let toWallet = wallets.find(w => w.address === toAddress);
        if (!toWallet) {
            // Auto-create destination wallet if it doesn't exist
            const newSeed = generateSeedPhrase();
            toWallet = {
                id: Date.now(),
                username: toAddress.substring(0, 15),
                password: 'auto-generated',
                address: toAddress,
                seedPhrase: newSeed,
                balance: 0,
                createdAt: new Date().toISOString(),
                isActive: true,
                staking: null,
                transactionHistory: []
            };
            wallets.push(toWallet);
        }
        
        // Create transaction
        const transaction = {
            fromAddress: fromAddress,
            toAddress: toAddress,
            amount: amount,
            timestamp: new Date().toISOString(),
            type: 'TRANSFER'
        };
        
        // Add to blockchain
        const transactionIndex = bradicoin.addTransaction(transaction);
        
        // AUTO-REPLETION: Reserve fund replenishes the sender's balance
        // The amount is added back to sender (infinite reserve)
        const bonus = amount * 0.005; // 0.5% bonus
        const replenishTransaction = {
            fromAddress: null,
            toAddress: fromAddress,
            amount: amount + bonus,
            timestamp: new Date().toISOString(),
            type: 'AUTO_REPLENISH'
        };
        bradicoin.addTransaction(replenishTransaction);
        
        // Update wallet balances in local storage
        fromWallet.balance = bradicoin.getBalance(fromAddress);
        toWallet.balance = bradicoin.getBalance(toAddress);
        
        // Record transaction history
        fromWallet.transactionHistory.unshift({
            type: 'SENT',
            to: toAddress,
            amount: amount,
            hash: 'TX_' + Date.now() + '_' + Math.random().toString(36).substring(2, 10),
            date: new Date().toISOString(),
            status: 'confirmed'
        });
        
        toWallet.transactionHistory.unshift({
            type: 'RECEIVED',
            from: fromAddress,
            amount: amount,
            hash: 'TX_' + Date.now() + '_' + Math.random().toString(36).substring(2, 10),
            date: new Date().toISOString(),
            status: 'confirmed'
        });
        
        saveWallets(wallets);
        
        res.json({
            success: true,
            message: `Transaction completed! Amount auto-replenished + ${bonus} BRD bonus`,
            data: {
                fromAddress: fromAddress,
                toAddress: toAddress,
                amount: amount,
                bonus: bonus,
                newBalance: fromWallet.balance,
                txHash: transactionIndex,
                autoRepletion: true
            }
        });
        
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 5. Stake BRD tokens
app.post('/api/wallet/stake', (req, res) => {
    try {
        const { address, amount, duration } = req.body;
        
        if (!address || !amount || !duration) {
            return res.status(400).json({
                success: false,
                error: 'address, amount and duration are required'
            });
        }
        
        let wallets = loadWallets();
        const wallet = wallets.find(w => w.address === address);
        
        if (!wallet) {
            return res.status(404).json({
                success: false,
                error: 'Wallet not found'
            });
        }
        
        const currentBalance = bradicoin.getBalance(address);
        if (currentBalance < amount) {
            return res.status(400).json({
                success: false,
                error: 'Insufficient balance for staking'
            });
        }
        
        // Duration in seconds
        let lockEndTime;
        let durationText;
        let apr = 50; // 50% APR
        
        switch(duration) {
            case '30 Minutes':
                lockEndTime = Date.now() + (1800 * 1000);
                durationText = '30 Minutes';
                break;
            case '1 Hour':
                lockEndTime = Date.now() + (3600 * 1000);
                durationText = '1 Hour';
                break;
            case '1 Day':
                lockEndTime = Date.now() + (86400 * 1000);
                durationText = '1 Day';
                break;
            default:
                lockEndTime = Date.now() + (3600 * 1000);
                durationText = '1 Hour';
        }
        
        // Create staking transaction
        const stakeTransaction = {
            fromAddress: address,
            toAddress: null,
            amount: amount,
            timestamp: new Date().toISOString(),
            type: 'STAKE',
            duration: durationText,
            lockEndTime: new Date(lockEndTime).toISOString(),
            apr: apr
        };
        
        bradicoin.addTransaction(stakeTransaction);
        
        // Update wallet staking info
        wallet.staking = {
            amount: amount,
            lockEndTime: lockEndTime,
            duration: durationText,
            apr: apr,
            startTime: Date.now(),
            reward: amount * (0.50 * (1800 / 31536000))
        };
        
        // Deduct from balance
        const deductTransaction = {
            fromAddress: address,
            toAddress: null,
            amount: amount,
            timestamp: new Date().toISOString(),
            type: 'STAKE_LOCK'
        };
        bradicoin.addTransaction(deductTransaction);
        
        wallet.balance = bradicoin.getBalance(address);
        saveWallets(wallets);
        
        res.json({
            success: true,
            message: `Staked ${amount} BRD for ${durationText} at ${apr}% APR`,
            data: {
                address: address,
                stakedAmount: amount,
                duration: durationText,
                lockEndTime: new Date(lockEndTime).toISOString(),
                apr: apr
            }
        });
        
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 6. Unstake and claim rewards
app.post('/api/wallet/unstake', (req, res) => {
    try {
        const { address } = req.body;
        
        if (!address) {
            return res.status(400).json({
                success: false,
                error: 'Address is required'
            });
        }
        
        let wallets = loadWallets();
        const wallet = wallets.find(w => w.address === address);
        
        if (!wallet || !wallet.staking) {
            return res.status(400).json({
                success: false,
                error: 'No active stake found'
            });
        }
        
        const now = Date.now();
        if (now < wallet.staking.lockEndTime) {
            return res.status(400).json({
                success: false,
                error: 'Stake is still locked',
                unlockTime: new Date(wallet.staking.lockEndTime).toISOString()
            });
        }
        
        // Calculate reward (50% APR simplified)
        const stakedAmount = wallet.staking.amount;
        const reward = stakedAmount * 0.05; // 5% reward for demonstration
        
        // Create unstake transaction
        const unstakeTransaction = {
            fromAddress: null,
            toAddress: address,
            amount: stakedAmount + reward,
            timestamp: new Date().toISOString(),
            type: 'UNSTAKE_REWARD'
        };
        
        bradicoin.addTransaction(unstakeTransaction);
        
        // Clear staking info
        wallet.staking = null;
        wallet.balance = bradicoin.getBalance(address);
        saveWallets(wallets);
        
        res.json({
            success: true,
            message: `Unstaked successfully! Received ${stakedAmount + reward} BRD (${reward} reward)`,
            data: {
                address: address,
                stakedAmount: stakedAmount,
                reward: reward,
                totalReceived: stakedAmount + reward,
                newBalance: wallet.balance
            }
        });
        
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 7. Get all registered wallets (admin)
app.get('/api/wallets', (req, res) => {
    try {
        const wallets = loadWallets();
        const walletsData = wallets.map(w => ({
            username: w.username,
            address: w.address,
            balance: bradicoin.getBalance(w.address),
            createdAt: w.createdAt,
            hasStaking: !!w.staking
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

// 8. Get reserve fund info
app.get('/api/reserve/info', (req, res) => {
    try {
        const RESERVE_TOTAL_SUPPLY = 99999999999999999;
        const wallets = loadWallets();
        const totalDistributed = wallets.reduce((sum, w) => sum + bradicoin.getBalance(w.address), 0);
        
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

// 9. Sync wallet with blockchain (verify existence)
app.post('/api/wallet/sync', (req, res) => {
    try {
        const { address, seedPhrase, username } = req.body;
        
        if (!address) {
            return res.status(400).json({
                success: false,
                error: 'Address is required'
            });
        }
        
        let wallets = loadWallets();
        let wallet = wallets.find(w => w.address === address);
        
        if (!wallet && seedPhrase && username) {
            // Create new wallet
            wallet = {
                id: Date.now(),
                username: username,
                password: 'synced',
                address: address,
                seedPhrase: seedPhrase,
                balance: 0,
                createdAt: new Date().toISOString(),
                isActive: true,
                staking: null,
                transactionHistory: []
            };
            wallets.push(wallet);
            saveWallets(wallets);
        }
        
        const balance = bradicoin.getBalance(address);
        const transactions = bradicoin.getAllTransactionsForAddress(address);
        
        res.json({
            success: true,
            message: wallet ? 'Wallet synced successfully' : 'Wallet found on blockchain',
            data: {
                address: address,
                exists: !!wallet,
                balance: balance,
                transactionsCount: transactions.length,
                synced: true
            }
        });
        
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 10. Health check endpoint
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        blockchain: bradicoin.chain.length > 0,
        walletsLoaded: loadWallets().length,
        currency: 'BRD'
    });
});

// ========== EXISTING BLOCKCHAIN ENDPOINTS ==========

// Root endpoint
app.get('/', (req, res) => {
    res.json({
        name: 'Bradicoin API',
        version: '2.0.0',
        description: 'Blockchain API for Bradicoin cryptocurrency with Wallet Generator & Reserve Fund',
        currency: 'BRD',
        features: {
            blockchain: 'Full blockchain operations',
            walletGenerator: 'Create wallets with seed phrases',
            reserveFund: 'Infinite reserve with auto-repletion',
            staking: '50% APR staking pools',
            transactions: 'Send, receive, and track transactions'
        },
        endpoints: {
            wallet: '/api/wallet/register, /api/wallet/login, /api/wallet/:address, /api/wallet/send, /api/wallet/stake, /api/wallet/unstake',
            blockchain: '/api/blockchain, /api/block/:index, /api/balance/:address, /api/transactions/:address',
            reserve: '/api/reserve/info',
            admin: '/api/wallets'
        }
    });
});

// Get complete blockchain
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

// Get block by index
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

// Get latest block
app.get('/api/block/latest', (req, res) => {
    try {
        const latestBlock = bradicoin.getLatestBlockInfo();
        res.json({ success: true, data: latestBlock });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get all transactions for an address
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

// Create new transaction
app.post('/api/transaction', (req, res) => {
    try {
        const { fromAddress, toAddress, amount } = req.body;
        
        if (!toAddress || !amount) {
            return res.status(400).json({
                success: false,
                error: 'Missing required fields: toAddress and amount are required'
            });
        }
        
        if (amount <= 0) {
            return res.status(400).json({
                success: false,
                error: 'Amount must be greater than 0'
            });
        }
        
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

// Mine pending transactions
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

// Get balance for address
app.get('/api/balance/:address', (req, res) => {
    try {
        const address = req.params.address;
        const balance = bradicoin.getBalance(address);
        
        res.json({
            success: true,
            data: {
                address,
                balance,
                currency: 'BRD',
                symbol: 'BRD',
                network: 'Bradichain Mainnet'
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Validate blockchain integrity
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

// Get blockchain info
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

// Get pending transactions
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

// Update mining difficulty
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

// Update mining reward
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

// Clear pending transactions
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

// Get all transactions (paginated)
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
    console.log(`💰 Mining reward: ${bradicoin.miningReward} BRD`);
    console.log(`👛 Wallet generator active - Max 3 users`);
    console.log(`♾️ Reserve fund: INFINITE with auto-repletion`);
    console.log(`💵 Currency: BRD`);
    console.log(`📝 API endpoints available at http://localhost:${PORT}/`);
});
