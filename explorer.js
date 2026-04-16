class BlockExplorer {
    constructor(blockchain, walletManager) {
        this.blockchain = blockchain;
        this.walletManager = walletManager;
        this.cache = new Map();
        this.cacheTimeout = 30000; // 30 seconds cache
    }

    // Get blockchain summary
    getBlockchainSummary() {
        const chain = this.blockchain.chain;
        const latestBlock = chain[chain.length - 1];
        
        let totalTransactions = 0;
        for (const block of chain) {
            if (block.transactions && Array.isArray(block.transactions)) {
                totalTransactions += block.transactions.length;
            }
        }
        
        return {
            chainName: 'Bradicoin',
            symbol: 'BRD',
            blockHeight: chain.length,
            latestBlockHash: latestBlock.hash,
            latestBlockTimestamp: latestBlock.timestamp,
            totalTransactions: totalTransactions,
            miningDifficulty: this.blockchain.difficulty,
            miningReward: this.blockchain.miningReward,
            isChainValid: this.blockchain.isChainValid(),
            totalSupply: this.calculateTotalSupply(),
            lastUpdated: new Date().toISOString()
        };
    }

    // Calculate total supply of BRD
    calculateTotalSupply() {
        let totalMined = 0;
        for (const block of this.blockchain.chain) {
            if (block.transactions && Array.isArray(block.transactions)) {
                for (const tx of block.transactions) {
                    // Check if it's a mining reward transaction
                    if (tx.fromAddress === null && tx.toAddress) {
                        totalMined += tx.amount || 0;
                    }
                }
            }
        }
        return totalMined;
    }

    // Get block details by index or hash
    getBlock(query) {
        let block = null;
        
        // Check if query is number (index) or string (hash)
        if (typeof query === 'number') {
            block = this.blockchain.getBlockByIndex(query);
        } else if (typeof query === 'string') {
            block = this.findBlockByHash(query);
        }
        
        if (!block) {
            throw new Error('Block not found');
        }
        
        return this.formatBlock(block);
    }

    // Find block by hash
    findBlockByHash(hash) {
        for (const block of this.blockchain.chain) {
            if (block.hash === hash) {
                return block;
            }
        }
        return null;
    }

    // Format block for display
    formatBlock(block) {
        const transactions = [];
        let totalAmount = 0;
        
        if (block.transactions && Array.isArray(block.transactions)) {
            for (const tx of block.transactions) {
                if (tx !== 'Genesis Block - Bradicoin') {
                    transactions.push({
                        id: tx.id || this.generateTxId(tx),
                        from: tx.fromAddress || 'COINBASE',
                        to: tx.toAddress,
                        amount: tx.amount,
                        fee: tx.fee || 0,
                        type: tx.type || 'TRANSFER',
                        timestamp: tx.timestamp,
                        status: tx.status || 'CONFIRMED'
                    });
                    totalAmount += tx.amount || 0;
                }
            }
        }
        
        return {
            index: block.index,
            hash: block.hash,
            previousHash: block.previousHash,
            timestamp: block.timestamp,
            transactionsCount: transactions.length,
            transactions: transactions.slice(0, 25), // Limit to 25 per request
            totalAmount: totalAmount,
            nonce: block.nonce,
            size: JSON.stringify(block).length,
            isGenesis: block.index === 0
        };
    }

    // Get recent blocks (paginated)
    getRecentBlocks(limit = 10, offset = 0) {
        const chain = [...this.blockchain.chain].reverse();
        const paginated = chain.slice(offset, offset + limit);
        
        const blocks = paginated.map(block => ({
            index: block.index,
            hash: block.hash,
            previousHash: block.previousHash,
            timestamp: block.timestamp,
            transactionsCount: block.transactions ? block.transactions.length : 0,
            size: JSON.stringify(block).length,
            isGenesis: block.index === 0
        }));
        
        return {
            totalBlocks: this.blockchain.chain.length,
            limit: limit,
            offset: offset,
            blocks: blocks
        };
    }

    // Get transaction details by ID
    getTransaction(txId) {
        // Search in blockchain
        for (const block of this.blockchain.chain) {
            if (block.transactions && Array.isArray(block.transactions)) {
                for (const tx of block.transactions) {
                    if (tx.id === txId) {
                        return {
                            id: tx.id,
                            blockIndex: block.index,
                            blockHash: block.hash,
                            confirmations: this.blockchain.chain.length - block.index,
                            from: tx.fromAddress || 'COINBASE',
                            to: tx.toAddress,
                            amount: tx.amount,
                            fee: tx.fee || 0,
                            total: (tx.amount || 0) + (tx.fee || 0),
                            type: tx.type || 'TRANSFER',
                            status: 'CONFIRMED',
                            timestamp: tx.timestamp,
                            confirmedAt: block.timestamp
                        };
                    }
                }
            }
        }
        
        // Check pending transactions
        if (this.walletManager) {
            const pending = this.walletManager.getPendingTransactions();
            const pendingTx = pending.find(tx => tx.id === txId);
            if (pendingTx) {
                return {
                    id: pendingTx.id,
                    blockIndex: null,
                    blockHash: null,
                    confirmations: 0,
                    from: pendingTx.fromAddress,
                    to: pendingTx.toAddress,
                    amount: pendingTx.amount,
                    fee: pendingTx.fee,
                    total: pendingTx.amount + (pendingTx.fee || 0),
                    type: 'TRANSFER',
                    status: 'PENDING',
                    timestamp: pendingTx.timestamp,
                    confirmedAt: null
                };
            }
        }
        
        throw new Error('Transaction not found');
    }

    // Get all transactions for an address
    getAddressTransactions(address, limit = 50, offset = 0) {
        const transactions = [];
        
        for (const block of this.blockchain.chain) {
            if (block.transactions && Array.isArray(block.transactions)) {
                for (const tx of block.transactions) {
                    if (tx.fromAddress === address || tx.toAddress === address) {
                        transactions.push({
                            id: tx.id || this.generateTxId(tx),
                            blockIndex: block.index,
                            blockHash: block.hash,
                            confirmations: this.blockchain.chain.length - block.index,
                            type: tx.fromAddress === address ? 'SENT' : 'RECEIVED',
                            from: tx.fromAddress || 'COINBASE',
                            to: tx.toAddress,
                            amount: tx.amount,
                            fee: tx.fee || 0,
                            timestamp: tx.timestamp,
                            status: 'CONFIRMED'
                        });
                    }
                }
            }
        }
        
        // Sort by block index descending (newest first)
        transactions.sort((a, b) => b.blockIndex - a.blockIndex);
        
        const paginated = transactions.slice(offset, offset + limit);
        
        return {
            address: address,
            balance: this.walletManager ? this.walletManager.getBalance(address) : 0,
            totalTransactions: transactions.length,
            limit: limit,
            offset: offset,
            transactions: paginated
        };
    }

    // Get address summary
    getAddressSummary(address) {
        const balance = this.walletManager ? this.walletManager.getBalance(address) : 0;
        const transactions = this.getAddressTransactions(address, 100, 0);
        
        let totalSent = 0;
        let totalReceived = 0;
        
        for (const tx of transactions.transactions) {
            if (tx.type === 'SENT') {
                totalSent += tx.amount;
            } else {
                totalReceived += tx.amount;
            }
        }
        
        // Check if address has stake
        let stakingInfo = null;
        if (this.blockchain.stakingManager) {
            try {
                stakingInfo = this.blockchain.stakingManager.getStakingInfo(address);
            } catch (e) {
                stakingInfo = null;
            }
        }
        
        return {
            address: address,
            balance: balance,
            totalSent: totalSent,
            totalReceived: totalReceived,
            transactionsCount: transactions.totalTransactions,
            firstSeen: this.getFirstSeen(address),
            hasStake: stakingInfo ? stakingInfo.hasStake : false,
            stakedAmount: stakingInfo && stakingInfo.hasStake ? stakingInfo.stakedAmount : 0,
            isRich: balance > 10000,
            rank: this.getAddressRank(address),
            url: `/explorer/address/${address}`
        };
    }

    // Get first transaction timestamp for address
    getFirstSeen(address) {
        for (const block of this.blockchain.chain) {
            if (block.transactions && Array.isArray(block.transactions)) {
                for (const tx of block.transactions) {
                    if (tx.fromAddress === address || tx.toAddress === address) {
                        return block.timestamp;
                    }
                }
            }
        }
        return null;
    }

    // Get address rank by balance
    getAddressRank(address) {
        const balances = [];
        
        if (this.walletManager) {
            const wallets = this.walletManager.getAllWallets();
            for (const wallet of wallets) {
                balances.push({
                    address: wallet.address,
                    balance: wallet.balance
                });
            }
            
            balances.sort((a, b) => b.balance - a.balance);
            
            const rank = balances.findIndex(b => b.address === address);
            return rank !== -1 ? rank + 1 : null;
        }
        
        return null;
    }

    // Get rich list (top holders)
    getRichList(limit = 100) {
        if (!this.walletManager) {
            throw new Error('Wallet manager not available');
        }
        
        const wallets = this.walletManager.getAllWallets();
        const sorted = wallets.sort((a, b) => b.balance - a.balance);
        const top = sorted.slice(0, limit);
        
        const totalSupply = this.calculateTotalSupply();
        const totalBalance = wallets.reduce((sum, w) => sum + w.balance, 0);
        
        return {
            totalWallets: wallets.length,
            totalBalance: totalBalance,
            totalSupply: totalSupply,
            percentageOfSupply: (totalBalance / totalSupply) * 100,
            limit: limit,
            holders: top.map((wallet, index) => ({
                rank: index + 1,
                address: wallet.address,
                balance: wallet.balance,
                percentage: (wallet.balance / totalBalance) * 100,
                isContract: wallet.address.includes('contract')
            }))
        };
    }

    // Get latest transactions across all blocks
    getLatestTransactions(limit = 20) {
        const transactions = [];
        
        // Collect from newest blocks first
        const reversedChain = [...this.blockchain.chain].reverse();
        
        for (const block of reversedChain) {
            if (block.transactions && Array.isArray(block.transactions)) {
                for (const tx of block.transactions) {
                    if (tx !== 'Genesis Block - Bradicoin' && tx.fromAddress !== 'staking-contract') {
                        transactions.push({
                            id: tx.id || this.generateTxId(tx),
                            blockIndex: block.index,
                            blockHash: block.hash,
                            from: tx.fromAddress || 'COINBASE',
                            to: tx.toAddress,
                            amount: tx.amount,
                            fee: tx.fee || 0,
                            timestamp: tx.timestamp,
                            confirmations: this.blockchain.chain.length - block.index
                        });
                        
                        if (transactions.length >= limit) {
                            break;
                        }
                    }
                }
            }
            if (transactions.length >= limit) {
                break;
            }
        }
        
        return {
            totalTransactions: this.getTotalTransactionCount(),
            limit: limit,
            transactions: transactions
        };
    }

    // Get total transaction count
    getTotalTransactionCount() {
        let count = 0;
        for (const block of this.blockchain.chain) {
            if (block.transactions && Array.isArray(block.transactions)) {
                for (const tx of block.transactions) {
                    if (tx !== 'Genesis Block - Bradicoin') {
                        count++;
                    }
                }
            }
        }
        return count;
    }

    // Search explorer (blocks, transactions, addresses)
    search(query) {
        const results = {
            query: query,
            blocks: [],
            transactions: [],
            addresses: []
        };
        
        // Search by block index
        if (!isNaN(parseInt(query))) {
            try {
                const block = this.getBlock(parseInt(query));
                results.blocks.push({
                    index: block.index,
                    hash: block.hash,
                    type: 'block'
                });
            } catch (e) {}
        }
        
        // Search by block hash
        try {
            const block = this.getBlock(query);
            if (block && !results.blocks.find(b => b.hash === block.hash)) {
                results.blocks.push({
                    index: block.index,
                    hash: block.hash,
                    type: 'block'
                });
            }
        } catch (e) {}
        
        // Search by transaction ID
        try {
            const tx = this.getTransaction(query);
            results.transactions.push({
                id: tx.id,
                from: tx.from,
                to: tx.to,
                type: 'transaction'
            });
        } catch (e) {}
        
        // Search by address
        if (query.startsWith('BRD-')) {
            try {
                const summary = this.getAddressSummary(query);
                results.addresses.push({
                    address: summary.address,
                    balance: summary.balance,
                    type: 'address'
                });
            } catch (e) {}
        }
        
        return {
            query: query,
            results: results,
            totalResults: results.blocks.length + results.transactions.length + results.addresses.length,
            timestamp: new Date().toISOString()
        };
    }

    // Get network statistics
    getNetworkStats() {
        const chain = this.blockchain.chain;
        const latestBlock = chain[chain.length - 1];
        
        // Calculate average block time (last 10 blocks)
        let avgBlockTime = 0;
        if (chain.length > 10) {
            const last10 = chain.slice(-10);
            let totalTime = 0;
            for (let i = 1; i < last10.length; i++) {
                const time1 = new Date(last10[i].timestamp).getTime();
                const time2 = new Date(last10[i-1].timestamp).getTime();
                totalTime += Math.abs(time1 - time2);
            }
            avgBlockTime = totalTime / (last10.length - 1) / 1000; // in seconds
        }
        
        return {
            network: 'Bradicoin Mainnet',
            symbol: 'BRD',
            blockHeight: chain.length,
            latestBlockHash: latestBlock.hash,
            latestBlockTimestamp: latestBlock.timestamp,
            miningDifficulty: this.blockchain.difficulty,
            miningReward: this.blockchain.miningReward,
            averageBlockTimeSeconds: Math.round(avgBlockTime),
            totalTransactions: this.getTotalTransactionCount(),
            totalSupply: this.calculateTotalSupply(),
            activeNodes: 1, // Placeholder for P2P network
            isSynced: true,
            lastUpdated: new Date().toISOString()
        };
    }

    // Generate transaction ID if not present
    generateTxId(transaction) {
        const data = JSON.stringify(transaction);
        const crypto = require('crypto');
        return crypto.createHash('sha256').update(data).digest('hex').substring(0, 32);
    }

    // Clear cache
    clearCache() {
        this.cache.clear();
        return { success: true, message: 'Cache cleared' };
    }
}

module.exports = BlockExplorer;
