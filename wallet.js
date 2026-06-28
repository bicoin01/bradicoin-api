// wallet.js - Complete wallet module with checksum, encoding and validator
// Maintains all existing functionality while adding standard crypto

const crypto = require('crypto');
const EC = require('elliptic').ec;
const BradicoinChecksum = require('./checksum');
const BradicoinValidator = require('./validator');
const BradicoinEncoding = require('./encoding');

// Inicializa a curva secp256k1
const ec = new EC('secp256k1');

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
            // 1. Derive public key from private key usando elliptic
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
     * Derive public key from private key usando elliptic
     * Agora com suporte completo a secp256k1
     */
    _derivePublicKey(privateKey) {
        try {
            // Converte private key para Buffer
            const privateKeyBuffer = Buffer.from(privateKey, 'hex');
            
            // Cria chave privada no formato elliptic
            const keyPair = ec.keyFromPrivate(privateKeyBuffer);
            
            // Obtém chave pública (formato compactado/uncompressed)
            const publicKey = keyPair.getPublic();
            
            // Retorna no formato Buffer (com 0x04 para uncompressed)
            const pubKeyBuffer = Buffer.from(publicKey.encode('hex', false), 'hex');
            
            // Se quiser compressed, use:
            // const pubKeyBuffer = Buffer.from(publicKey.encode('hex', true), 'hex');
            
            return pubKeyBuffer;
        } catch (error) {
            // Fallback: método simplificado para compatibilidade
            const hash = crypto.createHash('sha256').update(privateKey).digest();
            const publicKey = Buffer.concat([
                Buffer.from([0x04]),
                crypto.createHash('sha256').update(hash).digest(),
                crypto.createHash('sha256').update(hash).digest()
            ]);
            return publicKey;
        }
    }

    /**
     * Generate a new key pair (private + public key)
     */
    generateKeyPair() {
        const keyPair = ec.genKeyPair();
        const privateKey = keyPair.getPrivate('hex');
        const publicKey = keyPair.getPublic('hex', false);
        
        return {
            privateKey: privateKey,
            publicKey: publicKey,
            publicKeyCompressed: keyPair.getPublic('hex', true)
        };
    }

    /**
     * Get public key from private key
     */
    getPublicKey(privateKey, compressed = false) {
        try {
            const keyPair = ec.keyFromPrivate(Buffer.from(privateKey, 'hex'));
            return keyPair.getPublic('hex', compressed);
        } catch (error) {
            throw new Error(`Invalid private key: ${error.message}`);
        }
    }

    /**
     * Sign a message with private key
     */
    signMessage(privateKey, message) {
        try {
            const keyPair = ec.keyFromPrivate(Buffer.from(privateKey, 'hex'));
            const msgHash = crypto.createHash('sha256').update(message).digest();
            const signature = keyPair.sign(msgHash);
            
            return {
                r: signature.r.toString('hex'),
                s: signature.s.toString('hex'),
                recoveryParam: signature.recoveryParam,
                signature: signature.toDER('hex')
            };
        } catch (error) {
            throw new Error(`Failed to sign message: ${error.message}`);
        }
    }

    /**
     * Verify a signed message
     */
    verifyMessage(publicKey, message, signature) {
        try {
            const keyPair = ec.keyFromPublic(Buffer.from(publicKey, 'hex'), 'hex');
            const msgHash = crypto.createHash('sha256').update(message).digest();
            
            // Se signature for string hex, converte para DER
            let sig;
            if (typeof signature === 'string') {
                sig = Buffer.from(signature, 'hex');
            } else {
                sig = signature;
            }
            
            return keyPair.verify(msgHash, sig);
        } catch (error) {
            return false;
        }
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
        const keyPair = ec.genKeyPair();
        const privateKey = keyPair.getPrivate('hex');
        const address = this.generateAddressFromPrivateKey(privateKey);
        
        this.addresses.set(address, {
            privateKey: privateKey,
            balance: 0,
            createdAt: new Date(),
            transactions: [],
            totalReceived: 0,
            totalSent: 0,
            addressFormat: address.startsWith(this.addressPrefix) ? 'legacy' : 'standard',
            publicKey: keyPair.getPublic('hex', false),
            publicKeyCompressed: keyPair.getPublic('hex', true)
        });
        
        return {
            success: true,
            address: address,
            privateKey: privateKey,
            publicKey: keyPair.getPublic('hex', false),
            publicKeyCompressed: keyPair.getPublic('hex', true),
            format: address.startsWith(this.addressPrefix) ? 'legacy' : 'standard',
            message: '⚠️ Save your private key securely! You will need it to sign transactions. Never share it with anyone!'
        };
    }
    
    // Import existing wallet using private key
    importWallet(privateKey) {
        if (!privateKey || privateKey.length !== 64) {
            throw new Error('Invalid private key. Must be 64 characters hex string');
        }
        
        // Verifica se a private key é válida
        try {
            ec.keyFromPrivate(Buffer.from(privateKey, 'hex'));
        } catch (error) {
            throw new Error('Invalid private key format');
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
        
        // Obtém a chave pública
        const keyPair = ec.keyFromPrivate(Buffer.from(privateKey, 'hex'));
        
        this.addresses.set(address, {
            privateKey: privateKey,
            balance: 0,
            createdAt: new Date(),
            transactions: [],
            totalReceived: 0,
            totalSent: 0,
            addressFormat: address.startsWith(this.addressPrefix) ? 'legacy' : 'standard',
            publicKey: keyPair.getPublic('hex', false),
            publicKeyCompressed: keyPair.getPublic('hex', true)
        });
        
        return {
            success: true,
            address: address,
            publicKey: keyPair.getPublic('hex', false),
            publicKeyCompressed: keyPair.getPublic('hex', true),
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
            checksumValid: addressValidation.checksumValid !== undefined ? addressValidation.checksumValid : true,
            publicKey: wallet.publicKey || null,
            publicKeyCompressed: wallet.publicKeyCompressed || null
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
    // TRANSACTIONS (UPDATED WITH CRYPTO)
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
        
        // Create transaction data for signing
        const transactionData = {
            fromAddress: fromAddress,
            toAddress: toAddress,
            amount: amount,
            fee: this.transactionFee,
            timestamp: new Date().toISOString()
        };
        
        // Create transaction
        const transactionId = crypto.randomBytes(16).toString('hex');
        const signature = this.signTransaction(privateKey, transactionData);
        
        const transaction = {
            id: transactionId,
            fromAddress: fromAddress,
            toAddress: toAddress,
            amount: amount,
            fee: this.transactionFee,
            total: totalRequired,
            type: 'SEND',
            status: 'PENDING',
            timestamp: transactionData.timestamp,
            signature: signature,
            currency: 'BRD',
            transactionData: transactionData
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
                addressFormat: toAddress.startsWith(this.addressPrefix) ? 'legacy' : 'standard',
                publicKey: null,
                publicKeyCompressed: null
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
            signature: signature,
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
                currency: 'BRD',
                signature: tx.signature || null
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
                    currency: 'BRD',
                    signature: transaction.signature || null
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
                    currency: 'BRD',
                    signature: tx.signature || null
                });
            }
        }
        return pending;
    }
    
    // Sign transaction with private key (usando elliptic)
    signTransaction(privateKey, transactionData) {
        try {
            const keyPair = ec.keyFromPrivate(Buffer.from(privateKey, 'hex'));
            const message = JSON.stringify(transactionData);
            const msgHash = crypto.createHash('sha256').update(message).digest();
            const signature = keyPair.sign(msgHash);
            
            return signature.toDER('hex');
        } catch (error) {
            // Fallback para compatibilidade
            const message = JSON.stringify(transactionData);
            const signature = crypto
                .createHmac('sha256', privateKey)
                .update(message)
                .digest('hex');
            return signature;
        }
    }
    
    // Verify signature (usando elliptic)
    verifySignature(address, privateKey) {
        if (!this.addresses.has(address)) {
            return false;
        }
        
        const wallet = this.addresses.get(address);
        if (!wallet.privateKey) {
            return false;
        }
        
        try {
            // Verifica usando elliptic
            const keyPair = ec.keyFromPrivate(Buffer.from(privateKey, 'hex'));
            const testData = { test: 'verification', timestamp: Date.now() };
            const message = JSON.stringify(testData);
            const msgHash = crypto.createHash('sha256').update(message).digest();
            const signature = keyPair.sign(msgHash);
            
            // Verifica com a chave pública da carteira
            const pubKey = ec.keyFromPublic(Buffer.from(wallet.publicKey, 'hex'), 'hex');
            return pubKey.verify(msgHash, signature);
        } catch (error) {
            // Fallback para verificação simples
            const testData = { test: 'verification' };
            const testSignature = this.signTransaction(privateKey, testData);
            const expectedSignature = this.signTransaction(wallet.privateKey, testData);
            return testSignature === expectedSignature;
        }
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
                currency: 'BRD',
                hasPublicKey: !!wallet.publicKey
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
                addressFormat: address.startsWith(this.addressPrefix) ? 'legacy' : 'standard',
                publicKey: null,
                publicKeyCompressed: null
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
