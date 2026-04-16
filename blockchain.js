const SHA256 = require('crypto-js/sha256');

class Block {
    constructor(index, timestamp, transactions, previousHash = '') {
        this.index = index;
        this.timestamp = timestamp;
        this.transactions = transactions;
        this.previousHash = previousHash;
        this.hash = this.calculateHash();
        this.nonce = 0;
    }

    calculateHash() {
        return SHA256(
            this.index + 
            this.previousHash + 
            this.timestamp + 
            JSON.stringify(this.transactions) + 
            this.nonce
        ).toString();
    }

    mineBlock(difficulty) {
        const target = Array(difficulty + 1).join("0");
        while (this.hash.substring(0, difficulty) !== target) {
            this.nonce++;
            this.hash = this.calculateHash();
        }
        console.log(`Block mined: ${this.hash}`);
    }
}

class Blockchain {
    constructor() {
        this.chain = [this.createGenesisBlock()];
        this.difficulty = 4;
        this.pendingTransactions = [];
        this.miningReward = 100;
    }

    createGenesisBlock() {
        return new Block(0, "01/04/2026", "Genesis Block - Bradicoin", "0");
    }

    getLatestBlock() {
        return this.chain[this.chain.length - 1];
    }

    addTransaction(transaction) {
        if (!transaction.toAddress || !transaction.amount) {
            throw new Error('Transaction must include toAddress and amount');
        }
        
        transaction.timestamp = new Date().toISOString();
        this.pendingTransactions.push(transaction);
        
        return this.pendingTransactions.length - 1;
    }

    minePendingTransactions(minerAddress) {
        // Add mining reward
        const rewardTransaction = {
            fromAddress: null,
            toAddress: minerAddress,
            amount: this.miningReward,
            timestamp: new Date().toISOString()
        };
        
        this.pendingTransactions.push(rewardTransaction);
        
        const block = new Block(
            this.getLatestBlock().index + 1,
            new Date().toISOString(),
            this.pendingTransactions,
            this.getLatestBlock().hash
        );
        
        block.mineBlock(this.difficulty);
        
        console.log('Block successfully mined!');
        this.chain.push(block);
        
        // Reset pending transactions
        this.pendingTransactions = [];
        
        return block;
    }

    getBalance(address) {
        let balance = 0;
        
        for (const block of this.chain) {
            for (const transaction of block.transactions) {
                if (transaction.fromAddress === address) {
                    balance -= transaction.amount;
                }
                
                if (transaction.toAddress === address) {
                    balance += transaction.amount;
                }
            }
        }
        
        return balance;
    }

    getAllTransactionsForAddress(address) {
        const transactions = [];
        
        for (const block of this.chain) {
            for (const transaction of block.transactions) {
                if (transaction.fromAddress === address || transaction.toAddress === address) {
                    transactions.push({
                        ...transaction,
                        blockIndex: block.index
                    });
                }
            }
        }
        
        return transactions;
    }

    isChainValid() {
        for (let i = 1; i < this.chain.length; i++) {
            const currentBlock = this.chain[i];
            const previousBlock = this.chain[i - 1];

            // Validate current block hash
            if (currentBlock.hash !== currentBlock.calculateHash()) {
                console.log(`Invalid hash at block ${currentBlock.index}`);
                return false;
            }

            // Validate previous block link
            if (currentBlock.previousHash !== previousBlock.hash) {
                console.log(`Invalid previous hash link at block ${currentBlock.index}`);
                return false;
            }
        }
        
        console.log('Blockchain is valid!');
        return true;
    }

    getBlockByIndex(index) {
        if (index >= 0 && index < this.chain.length) {
            return this.chain[index];
        }
        return null;
    }

    getLatestBlockInfo() {
        const latestBlock = this.getLatestBlock();
        return {
            index: latestBlock.index,
            hash: latestBlock.hash,
            previousHash: latestBlock.previousHash,
            timestamp: latestBlock.timestamp,
            transactionsCount: latestBlock.transactions.length,
            nonce: latestBlock.nonce
        };
    }

    getChainInfo() {
        return {
            totalBlocks: this.chain.length,
            difficulty: this.difficulty,
            miningReward: this.miningReward,
            pendingTransactionsCount: this.pendingTransactions.length,
            isValid: this.isChainValid(),
            latestBlock: this.getLatestBlockInfo()
        };
    }

    getPendingTransactions() {
        return this.pendingTransactions;
    }

    clearPendingTransactions() {
        this.pendingTransactions = [];
        return { message: 'Pending transactions cleared', count: this.pendingTransactions.length };
    }

    updateDifficulty(newDifficulty) {
        if (newDifficulty >= 1 && newDifficulty <= 10) {
            this.difficulty = newDifficulty;
            return { message: `Difficulty updated to ${newDifficulty}`, newDifficulty };
        }
        throw new Error('Difficulty must be between 1 and 10');
    }

    updateMiningReward(newReward) {
        if (newReward > 0 && newReward <= 1000) {
            this.miningReward = newReward;
            return { message: `Mining reward updated to ${newReward} Bradicoins`, newReward };
        }
        throw new Error('Mining reward must be between 1 and 1000');
    }
}

module.exports = Blockchain;
