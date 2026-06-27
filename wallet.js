// wallet.js - Complete wallet module with checksum, encoding and validator
// Maintains all existing functionality while adding standard crypto

const crypto = require('crypto');
const BradicoinChecksum = require('./checksum');
const BradicoinValidator = require('./validator');
const BradicoinEncoding = require('./encoding');

class Wallet {
    constructor(network = 'mainnet') {
        this.network = network;
        this.versionByte = network === 'mainnet' ? 0x00 : 0x6F;
        
        // Initialize new modules
        this.checksumManager = new BradicoinChecksum();
        this.validator = new BradicoinValidator(network);
        this.encoding = new BradicoinEncoding(network);
        
        // Existing properties
        this.addresses = new Map(); // address -> { privateKey, balance, transactions, createdAt }
        this.pendingTransactions = new Map(); // txId -> { from, to, amount, status, timestamp }
        this.transactionFee = 0.01; // 0.01 BRD transaction fee
        this.minTransactionAmount = 0.01; // Minimum 0.01 BRD per transaction
        
        // Support both address formats (old and new)
        this.addressPrefix = 'BRD-'; // Legacy prefix
    }

    // ========================================
    // CORE ADDRESS GENERATION (UPDATED)
    // ========================================

    /**
     * Generate a new wallet address (Standard Base58Check)
     */
    generateStandardAddress(privateKey) {
        try {
            // 1. Derive public key from private key (simplified)
            // In production, use secp256k1 properly
            const publicKey = this._derivePublicKey(privateKey);
            
            // 2. Generate address using encoding module
            const address = this.encoding.publicKeyToAddress(publicKey);
            
            // 3. Validate the generated address
            const validation = this.validator.validateAddress(address);
            if (!validation.valid) {
                throw new Error(`Generated address is invalid: ${validation.error}`);
            }
            
            return address;
        } catch (error) {
            // Fallback to legacy format if standard fails
            return this.generateLegacyAddress(privateKey);
        }
    }

    /**
     * Generate legacy address (BRD- format) - kept for compatibility
     */
    generateLegacyAddress(privateKey) {
        const hash = crypto.createHash('sha256').update(privateKey).digest('hex');
        const addressHash = crypto.createHash('ripemd160').update(hash).digest('hex');
        return this.addressPrefix + addressHash.substring(0, 16).toUpperCase();
    }

    /**
     * Generate address from private key (auto-detects best format)
     */
    generateAddressFromPrivateKey(privateKey) {
        try {
            // Try standard format first
            const standardAddress = this.generateStandardAddress(privateKey);
            if (this.validator.validateAddress(standardAddress).valid) {
                return standardAddress;
            }
        } catch (error) {
            // Fallback to legacy
        }
        return this.generateLegacyAddress(privateKey);
    }

    /**
     * Derive public key from private key (simplified)
     * In production, use secp256k1 library
     */
    _derivePublicKey(privateKey) {
        // Simplified derivation - in production use proper ECDSA
        const hash = crypto.createHash('sha256').update(privateKey).digest();
        const publicKey = Buffer.concat([
            Buffer.from([0x04]),
            crypto.createHash('sha256').update(hash).digest(),
            crypto.createHash('sha256').update(hash).digest()
        ]);
        return publicKey;
    }

    // ========================================
    // ADDRESS VALIDATION (NEW)
    // ========================================

    /**
     * Validate an address (supports both formats)
     */
    isValidAddress(address) {
        // 1. Check legacy format (BRD-)
        if (address.startsWith(this.addressPrefix) && address.length === 21) {
            return true;
        }
        
        // 2. Check standard format
        const validation = this.validator.validateAddress(address);
        return validation.valid;
    }

    /**
     * Verify address with checksum
     */
    verifyAddress(address) {
        // Check legacy format
        if (address.startsWith(this.addressPrefix)) {
            return {
                valid: true,
                format: 'legacy',
                address: address,
                checksumValid: true
            };
        }
        
        // Check standard format
        const validation = this.validator.validateAddress(address);
        if (!validation.valid) {
            return validation;
        }

        const checksumVerification = this.checksumManager.verifyAddressChecksum(address);
        
        return {
            valid: true,
            address: address,
            format: 'standard',
            checksumValid: checksumVerification.valid,
            details: validation
        };
    }

    // ========================================
    // WALLET MANAGEMENT (MAINTAINED)
    // ========================================

    // Generate a new wallet address
    createWallet() {
        const privateKey = crypto.randomBytes(32).toString('hex');
        const address = this.generateAddressFromPrivateKey(privateKey);
        
        this.addresses.set(address, {
            privateKey: privateKey,
            balance: 0,
            createdAt: new Date(),
            transactions: [],
            totalReceived: 0,
            totalSent: 0,
            addressFormat: address.startsWith(this.addressPrefix) ? 'legacy' : 'standard'
        });
        
        return {
            success: true,
            address: address,
            privateKey: privateKey,
            format: address.startsWith(this.addressPrefix) ? 'legacy' : 'standard',
            message: '⚠️ Save your private key securely! You will need it to sign transactions. Never share it with anyone!'
        };
    }
    
    // Import existing wallet using private key
    importWallet(privateKey) {
        if (!privateKey || privateKey.length !== 64) {
            throw new Error('Invalid private key. Must be 64 characters hex string');
        }
        
        const address = this.generateAddressFromPrivateKey(privateKey);
        
        if (this.addresses.has(address)) {
            return {
                success: true,
                address: address,
                message: 'Wallet already exists in memory',
                isNew: false
            };
        }
        
        this.addresses.set(address, {
            privateKey: privateKey,
            balance: 0,
            createdAt: new Date(),
            transactions: [],
            totalReceived: 0,
            totalSent: 0,
            addressFormat: address.startsWith(this.addressPrefix) ? 'legacy' : 'standard'
        });
        
        return {
            success: true,
            address: address,
            message: 'Wallet imported successfully',
            isNew: true
        };
    }
    
    // Get complete wallet information
    getWalletInfo(address) {
        if (!this.addresses.has(address)) {
            throw new Error('Wallet address not found');
        }
        
        const wallet = this.addresses.get(address);
        const addressValidation = this.verifyAddress(address);
        
        return {
            success: true,
            address: address,
            balance: wallet.balance,
            createdAt: wallet.createdAt,
            createdDate: wallet.createdAt.toLocaleDateString(),
            transactionsCount: wallet.transactions.length,
            totalReceived: wallet.totalReceived,
            totalSent: wallet.totalSent,
            lastTransactions: wallet.transactions.slice(-10).reverse(),
            hasPrivateKey: !!wallet.privateKey,
            currency: 'BRD',
            addressFormat: wallet.addressFormat || 'legacy',
            isValid: addressValidation.valid,
            checksumValid: addressValidation.checksumValid !== undefined ? addressValidation.checksumValid : true
        };
    }
    
    // Get wallet balance only
    getBalance(address) {
        if (!this.addresses.has(address)) {
            return 0;
        }
        return this.addresses.get(address).balance;
    }

    // ========================================
    // TRANSACTIONS (MAINTAINED)
    // ========================================

    // Send Bradicoins to another address
    sendTransaction(fromAddress, toAddress, amount, privateKey = null) {
        // Validate addresses
        if (!this.addresses.has(fromAddress)) {
            throw new Error('Sender wallet not found. Please import or create wallet first');
        }
        
        // Validate recipient address
        if (!toAddress || toAddress.length < 10) {
            throw new Error('Invalid recipient address');
        }
        
        // Check if recipient address is valid
        if (!this.isValidAddress(toAddress)) {
            throw new Error('Invalid recipient address format');
        }
        
        // Validate amount
        if (amount <= 0) {
            throw new Error('Amount must be greater than 0');
        }
        
        if (amount < this.minTransactionAmount) {
            throw new Error(`Minimum transaction amount is ${this.minTransactionAmount} BRD`);
        }
        
        // Check balance including fee
        const totalRequired = amount + this.transactionFee;
        const senderWallet = this.addresses.get(fromAddress);
        
        if (senderWallet.balance < totalRequired) {
            throw new Error(`Insufficient balance. You have ${senderWallet.balance} BRD, need ${totalRequired} BRD (${amount} + ${this.transactionFee} fee)`);
        }
        
        // Verify signature if private key provided
        if (privateKey) {
            const isValid = this.verifySignature(fromAddress, privateKey);
            if (!isValid) {
                throw new Error('Invalid private key for this address');
            }
        } else if (senderWallet.privateKey) {
            privateKey = senderWallet.privateKey;
        } else {
            throw new Error('Private key required to sign transaction');
        }
        
        // Create transaction
        const transactionId = crypto.randomBytes(16).toString('hex');
        const transaction = {
            id: transactionId,
            fromAddress: fromAddress,
            toAddress: toAddress,
            amount: amount,
            fee: this.transactionFee,
            total: totalRequired,
            type: 'SEND',
            status: 'PENDING',
            timestamp: new Date().toISOString(),
            signature: this.signTransaction(privateKey, { fromAddress, toAddress, amount }),
            currency: 'BRD'
        };
        
        // Store pending transaction
        this.pendingTransactions.set(transactionId, transaction);
        
        // Update balances (will be finalized when block is mined)
        senderWallet.balance -= totalRequired;
        senderWallet.totalSent += amount;
        senderWallet.transactions.push({ ...transaction, status: 'PENDING' });
        
        // Create or update receiver wallet (auto-create if doesn't exist)
        if (!this.addresses.has(toAddress)) {
            this.addresses.set(toAddress, {
                privateKey: null,
                balance: 0,
                createdAt: new Date(),
                transactions: [],
                totalReceived: 0,
                totalSent: 0,
                addressFormat: toAddress.startsWith(this.addressPrefix) ? 'legacy' : 'standard'
            });
        }
        
        return {
            success: true,
            transactionId: transactionId,
            fromAddress: fromAddress,
            toAddress: toAddress,
            amount: amount,
            fee: this.transactionFee,
            status: 'PENDING',
            currency: 'BRD',
            message: `Transaction created successfully. Waiting for mining confirmation.`
        };
    }
    
    // Confirm transaction (called when block is mined)
    confirmTransaction(transactionId) {
        if (!this.pendingTransactions.has(transactionId)) {
            throw new Error('Transaction not found');
        }
        
        const transaction = this.pendingTransactions.get(transactionId);
        
        if (transaction.status === 'CONFIRMED') {
            return { success: true, message: 'Transaction already confirmed' };
        }
        
        // Update receiver balance
        const receiverWallet = this.addresses.get(transaction.toAddress);
        if (receiverWallet) {
            receiverWallet.balance += transaction.amount;
            receiverWallet.totalReceived += transaction.amount;
            receiverWallet.transactions.push({ ...transaction, status: 'CONFIRMED' });
        }
        
        // Update transaction status
        transaction.status = 'CONFIRMED';
        transaction.confirmedAt = new Date().toISOString();
        this.pendingTransactions.set(transactionId, transaction);
        
        // Update sender's transaction status
        const senderWallet = this.addresses.get(transaction.fromAddress);
        if (senderWallet) {
            const txIndex = senderWallet.transactions.findIndex(tx => tx.id === transactionId);
            if (txIndex !== -1) {
                senderWallet.transactions[txIndex].status = 'CONFIRMED';
                senderWallet.transactions[txIndex].confirmedAt = transaction.confirmedAt;
            }
        }
        
        return {
            success: true,
            transactionId: transactionId,
            status: 'CONFIRMED',
            currency: 'BRD',
            message: 'Transaction confirmed and added to blockchain'
        };
    }

    // ========================================
    // UTILITY FUNCTIONS (MAINTAINED)
    // ========================================

    // Get transaction status
    getTransactionStatus(transactionId) {
        if (this.pendingTransactions.has(transactionId)) {
            const tx = this.pendingTransactions.get(transactionId);
            return {
                success: true,
                transactionId: transactionId,
                status: tx.status,
                fromAddress: tx.fromAddress,
                toAddress: tx.toAddress,
                amount: tx.amount,
                fee: tx.fee,
                timestamp: tx.timestamp,
                confirmedAt: tx.confirmedAt || null,
                currency: 'BRD'
            };
        }
        
        // Check in blockchain (search all wallets)
        for (const [address, wallet] of this.addresses) {
            const transaction = wallet.transactions.find(tx => tx.id === transactionId);
            if (transaction) {
                return {
                    success: true,
                    transactionId: transactionId,
                    status: transaction.status,
                    fromAddress: transaction.fromAddress,
                    toAddress: transaction.toAddress,
                    amount: transaction.amount,
                    fee: transaction.fee,
                    timestamp: transaction.timestamp,
                    confirmedAt: transaction.confirmedAt || null,
                    currency: 'BRD'
                };
            }
        }
        
        throw new Error('Transaction not found');
    }
    
    // Get all pending transactions
    getPendingTransactions() {
        const pending = [];
        for (const [id, tx] of this.pendingTransactions) {
            if (tx.status === 'PENDING') {
                pending.push({
                    id: id,
                    fromAddress: tx.fromAddress,
                    toAddress: tx.toAddress,
                    amount: tx.amount,
                    fee: tx.fee,
                    timestamp: tx.timestamp,
                    currency: 'BRD'
                });
            }
        }
        return pending;
    }
    
    // Sign transaction with private key
    signTransaction(privateKey, transactionData) {
        const message = JSON.stringify(transactionData);
        const signature = crypto
            .createHmac('sha256', privateKey)
            .update(message)
            .digest('hex');
        return signature;
    }
    
    // Verify signature
    verifySignature(address, privateKey) {
        if (!this.addresses.has(address)) {
            return false;
        }
        
        const wallet = this.addresses.get(address);
        if (!wallet.privateKey) {
            return false;
        }
        
        const testData = { test: 'verification' };
        const testSignature = this.signTransaction(privateKey, testData);
        const expectedSignature = this.signTransaction(wallet.privateKey, testData);
        
        return testSignature === expectedSignature;
    }
    
    // Get all wallets summary (admin only)
    getAllWallets() {
        const wallets = [];
        for (const [address, wallet] of this.addresses) {
            wallets.push({
                address: address,
                balance: wallet.balance,
                createdAt: wallet.createdAt,
                createdDate: wallet.createdAt.toLocaleDateString(),
                transactionsCount: wallet.transactions.length,
                totalReceived: wallet.totalReceived,
                totalSent: wallet.totalSent,
                hasPrivateKey: !!wallet.privateKey,
                addressFormat: wallet.addressFormat || 'legacy',
                currency: 'BRD'
            });
        }
        return wallets;
    }
    
    // Get wallet transaction history
    getTransactionHistory(address, limit = 50, offset = 0) {
        if (!this.addresses.has(address)) {
            throw new Error('Wallet address not found');
        }
        
        const wallet = this.addresses.get(address);
        const transactions = wallet.transactions.slice().reverse();
        const paginated = transactions.slice(offset, offset + limit);
        
        return {
            success: true,
            address: address,
            totalTransactions: transactions.length,
            limit: limit,
            offset: offset,
            transactions: paginated,
            currency: 'BRD'
        };
    }
    
    // Update transaction fee
    updateTransactionFee(newFee) {
        if (newFee >= 0 && newFee <= 1) {
            this.transactionFee = newFee;
            return {
                success: true,
                newFee: newFee,
                currency: 'BRD',
                message: `Transaction fee updated to ${newFee} BRD`
            };
        }
        throw new Error('Transaction fee must be between 0 and 1 BRD');
    }
    
    // Update minimum transaction amount
    updateMinTransactionAmount(newMinAmount) {
        if (newMinAmount > 0 && newMinAmount <= 100) {
            this.minTransactionAmount = newMinAmount;
            return {
                success: true,
                newMinAmount: newMinAmount,
                currency: 'BRD',
                message: `Minimum transaction amount updated to ${newMinAmount} BRD`
            };
        }
        throw new Error('Minimum transaction amount must be between 0.01 and 100 BRD');
    }
    
    // Get wallet statistics
    getWalletStats() {
        let totalBalance = 0;
        let totalWallets = this.addresses.size;
        let totalTransactions = 0;
        let activeWallets = 0;
        
        for (const wallet of this.addresses.values()) {
            totalBalance += wallet.balance;
            totalTransactions += wallet.transactions.length;
            if (wallet.transactions.length > 0) {
                activeWallets++;
            }
        }
        
        return {
            totalWallets: totalWallets,
            activeWallets: activeWallets,
            inactiveWallets: totalWallets - activeWallets,
            totalBalance: totalBalance,
            totalTransactions: totalTransactions,
            pendingTransactions: this.pendingTransactions.size,
            transactionFee: this.transactionFee,
            minTransactionAmount: this.minTransactionAmount,
            currency: 'BRD'
        };
    }
    
    // Receive coins (simple method for receiving)
    receiveCoins(address, amount, fromAddress = 'external') {
        if (!this.addresses.has(address)) {
            this.addresses.set(address, {
                privateKey: null,
                balance: 0,
                createdAt: new Date(),
                transactions: [],
                totalReceived: 0,
                totalSent: 0,
                addressFormat: address.startsWith(this.addressPrefix) ? 'legacy' : 'standard'
            });
        }
        
        const wallet = this.addresses.get(address);
        const transactionId = crypto.randomBytes(16).toString('hex');
        
        const transaction = {
            id: transactionId,
            fromAddress: fromAddress,
            toAddress: address,
            amount: amount,
            fee: 0,
            type: 'RECEIVE',
            status: 'CONFIRMED',
            timestamp: new Date().toISOString(),
            confirmedAt: new Date().toISOString(),
            currency: 'BRD'
        };
        
        wallet.balance += amount;
        wallet.totalReceived += amount;
        wallet.transactions.push(transaction);
        
        return {
            success: true,
            transactionId: transactionId,
            address: address,
            amount: amount,
            newBalance: wallet.balance,
            currency: 'BRD',
            message: `${amount} BRD received successfully`
        };
    }
}

module.exports = Wallet;
