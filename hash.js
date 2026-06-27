// hash.js - Cryptographic hash functions for Bradicoin
// Place this file in the project root

const crypto = require('crypto');

/**
 * HashManager class for Bradicoin
 * Provides all cryptographic hash functions needed for the wallet
 */
class HashManager {
    constructor() {
        this.supportedAlgorithms = {
            SHA256: 'sha256',
            SHA512: 'sha512',
            RIPEMD160: 'ripemd160',
            HASH160: 'hash160', // Custom: SHA-256 + RIPEMD-160
            HASH256: 'hash256', // Custom: Double SHA-256
            HMAC_SHA256: 'hmac-sha256',
            HMAC_SHA512: 'hmac-sha512'
        };
    }

    // ========================================
    // 1. BASIC HASH FUNCTIONS
    // ========================================

    /**
     * SHA-256 hash
     * @param {Buffer|string} data - Data to hash
     * @param {string} encoding - Output encoding ('hex', 'base64', 'buffer')
     * @returns {string|Buffer} - Hashed data
     */
    sha256(data, encoding = 'hex') {
        try {
            const buffer = this._toBuffer(data);
            const hash = crypto.createHash('sha256').update(buffer).digest();
            return this._formatOutput(hash, encoding);
        } catch (error) {
            throw new Error(`SHA-256 failed: ${error.message}`);
        }
    }

    /**
     * SHA-512 hash
     * @param {Buffer|string} data - Data to hash
     * @param {string} encoding - Output encoding ('hex', 'base64', 'buffer')
     * @returns {string|Buffer} - Hashed data
     */
    sha512(data, encoding = 'hex') {
        try {
            const buffer = this._toBuffer(data);
            const hash = crypto.createHash('sha512').update(buffer).digest();
            return this._formatOutput(hash, encoding);
        } catch (error) {
            throw new Error(`SHA-512 failed: ${error.message}`);
        }
    }

    /**
     * RIPEMD-160 hash
     * @param {Buffer|string} data - Data to hash
     * @param {string} encoding - Output encoding ('hex', 'base64', 'buffer')
     * @returns {string|Buffer} - Hashed data
     */
    ripemd160(data, encoding = 'hex') {
        try {
            const buffer = this._toBuffer(data);
            const hash = crypto.createHash('ripemd160').update(buffer).digest();
            return this._formatOutput(hash, encoding);
        } catch (error) {
            throw new Error(`RIPEMD-160 failed: ${error.message}`);
        }
    }

    // ========================================
    // 2. COMPOSITE HASH FUNCTIONS
    // ========================================

    /**
     * HASH160 = SHA-256 + RIPEMD-160
     * Used for Bitcoin/Bradicoin address generation
     * @param {Buffer|string} data - Data to hash
     * @param {string} encoding - Output encoding ('hex', 'base64', 'buffer')
     * @returns {string|Buffer} - 20-byte hash
     */
    hash160(data, encoding = 'hex') {
        try {
            const buffer = this._toBuffer(data);
            // Step 1: SHA-256
            const sha256Hash = crypto.createHash('sha256').update(buffer).digest();
            // Step 2: RIPEMD-160
            const ripemd160Hash = crypto.createHash('ripemd160').update(sha256Hash).digest();
            return this._formatOutput(ripemd160Hash, encoding);
        } catch (error) {
            throw new Error(`HASH160 failed: ${error.message}`);
        }
    }

    /**
     * HASH256 = Double SHA-256
     * Used for checksums and transaction hashing
     * @param {Buffer|string} data - Data to hash
     * @param {string} encoding - Output encoding ('hex', 'base64', 'buffer')
     * @returns {string|Buffer} - 32-byte hash
     */
    hash256(data, encoding = 'hex') {
        try {
            const buffer = this._toBuffer(data);
            // Step 1: First SHA-256
            const firstHash = crypto.createHash('sha256').update(buffer).digest();
            // Step 2: Second SHA-256
            const secondHash = crypto.createHash('sha256').update(firstHash).digest();
            return this._formatOutput(secondHash, encoding);
        } catch (error) {
            throw new Error(`HASH256 failed: ${error.message}`);
        }
    }

    /**
     * HASH160 with buffer input (convenience method)
     * @param {Buffer} data - Buffer to hash
     * @returns {Buffer} - 20-byte hash buffer
     */
    hash160Buffer(data) {
        return this.hash160(data, 'buffer');
    }

    /**
     * HASH256 with buffer input (convenience method)
     * @param {Buffer} data - Buffer to hash
     * @returns {Buffer} - 32-byte hash buffer
     */
    hash256Buffer(data) {
        return this.hash256(data, 'buffer');
    }

    // ========================================
    // 3. HMAC FUNCTIONS
    // ========================================

    /**
     * HMAC-SHA256
     * @param {Buffer|string} key - Secret key
     * @param {Buffer|string} data - Data to hash
     * @param {string} encoding - Output encoding ('hex', 'base64', 'buffer')
     * @returns {string|Buffer} - HMAC hash
     */
    hmacSha256(key, data, encoding = 'hex') {
        try {
            const keyBuffer = this._toBuffer(key);
            const dataBuffer = this._toBuffer(data);
            const hash = crypto.createHmac('sha256', keyBuffer)
                .update(dataBuffer)
                .digest();
            return this._formatOutput(hash, encoding);
        } catch (error) {
            throw new Error(`HMAC-SHA256 failed: ${error.message}`);
        }
    }

    /**
     * HMAC-SHA512
     * @param {Buffer|string} key - Secret key
     * @param {Buffer|string} data - Data to hash
     * @param {string} encoding - Output encoding ('hex', 'base64', 'buffer')
     * @returns {string|Buffer} - HMAC hash
     */
    hmacSha512(key, data, encoding = 'hex') {
        try {
            const keyBuffer = this._toBuffer(key);
            const dataBuffer = this._toBuffer(data);
            const hash = crypto.createHmac('sha512', keyBuffer)
                .update(dataBuffer)
                .digest();
            return this._formatOutput(hash, encoding);
        } catch (error) {
            throw new Error(`HMAC-SHA512 failed: ${error.message}`);
        }
    }

    // ========================================
    // 4. PBKDF2 FUNCTIONS
    // ========================================

    /**
     * PBKDF2 key derivation (used for BIP39)
     * @param {string} password - Password/seed phrase
     * @param {string} salt - Salt
     * @param {number} iterations - Number of iterations
     * @param {number} keyLength - Desired key length in bytes
     * @param {string} digest - Hash algorithm ('sha256', 'sha512')
     * @param {string} encoding - Output encoding ('hex', 'base64', 'buffer')
     * @returns {string|Buffer} - Derived key
     */
    pbkdf2(password, salt, iterations = 2048, keyLength = 64, digest = 'sha512', encoding = 'hex') {
        try {
            const derivedKey = crypto.pbkdf2Sync(
                password,
                salt,
                iterations,
                keyLength,
                digest
            );
            return this._formatOutput(derivedKey, encoding);
        } catch (error) {
            throw new Error(`PBKDF2 failed: ${error.message}`);
        }
    }

    /**
     * PBKDF2 for BIP39 (convenience method)
     * @param {string} mnemonic - BIP39 mnemonic phrase
     * @param {string} passphrase - Optional passphrase
     * @param {string} encoding - Output encoding ('hex', 'base64', 'buffer')
     * @returns {string|Buffer} - 64-byte seed
     */
    bip39Seed(mnemonic, passphrase = '', encoding = 'hex') {
        const salt = 'mnemonic' + passphrase;
        return this.pbkdf2(mnemonic, salt, 2048, 64, 'sha512', encoding);
    }

    // ========================================
    // 5. UTILITY FUNCTIONS
    // ========================================

    /**
     * Convert input to Buffer
     * @private
     */
    _toBuffer(data) {
        if (Buffer.isBuffer(data)) {
            return data;
        }
        if (typeof data === 'string') {
            // Check if it's hex
            if (/^[0-9a-fA-F]+$/.test(data) && data.length % 2 === 0) {
                return Buffer.from(data, 'hex');
            }
            return Buffer.from(data, 'utf8');
        }
        if (typeof data === 'number' || typeof data === 'boolean') {
            return Buffer.from(String(data), 'utf8');
        }
        if (data instanceof Uint8Array) {
            return Buffer.from(data);
        }
        throw new Error('Unsupported data type for hashing');
    }

    /**
     * Format output based on encoding
     * @private
     */
    _formatOutput(buffer, encoding) {
        if (encoding === 'buffer') {
            return buffer;
        }
        if (encoding === 'hex') {
            return buffer.toString('hex');
        }
        if (encoding === 'base64') {
            return buffer.toString('base64');
        }
        throw new Error(`Unsupported encoding: ${encoding}`);
    }

    /**
     * Compare two hash values securely (timing-safe)
     * @param {Buffer|string} a - First hash
     * @param {Buffer|string} b - Second hash
     * @returns {boolean} - True if equal
     */
    secureCompare(a, b) {
        try {
            const aBuffer = this._toBuffer(a);
            const bBuffer = this._toBuffer(b);
            return crypto.timingSafeEqual(aBuffer, bBuffer);
        } catch (error) {
            return false;
        }
    }

    /**
     * Verify if a hash matches the expected value
     * @param {Buffer|string} data - Original data
     * @param {Buffer|string} expectedHash - Expected hash
     * @param {string} algorithm - Hash algorithm to use
     * @returns {boolean} - True if hash matches
     */
    verifyHash(data, expectedHash, algorithm = 'sha256') {
        try {
            const calculated = this[algorithm](data, 'buffer');
            const expected = this._toBuffer(expectedHash);
            return this.secureCompare(calculated, expected);
        } catch (error) {
            return false;
        }
    }

    // ========================================
    // 6. HASH FUNCTIONS FOR TRANSACTIONS
    // ========================================

    /**
     * Hash a transaction for signing
     * @param {Object} transaction - Transaction data
     * @param {string} encoding - Output encoding
     * @returns {string|Buffer} - Transaction hash
     */
    hashTransaction(transaction, encoding = 'hex') {
        try {
            // Serialize transaction data
            const serialized = JSON.stringify(transaction);
            // Hash with double SHA-256
            return this.hash256(serialized, encoding);
        } catch (error) {
            throw new Error(`Transaction hashing failed: ${error.message}`);
        }
    }

    /**
     * Generate transaction ID (TXID)
     * @param {Object} transaction - Transaction data
     * @param {string} encoding - Output encoding
     * @returns {string|Buffer} - Transaction ID
     */
    generateTxId(transaction, encoding = 'hex') {
        // Transaction ID is the hash of the transaction
        return this.hashTransaction(transaction, encoding);
    }

    // ========================================
    // 7. HASH FUNCTIONS FOR WALLETS
    // ========================================

    /**
     * Generate address hash from public key
     * @param {Buffer|string} publicKey - Public key
     * @param {string} encoding - Output encoding
     * @returns {string|Buffer} - Address hash (HASH160)
     */
    addressHash(publicKey, encoding = 'hex') {
        return this.hash160(publicKey, encoding);
    }

    /**
     * Generate checksum for address
     * @param {Buffer|string} payload - Payload (version + hash)
     * @param {string} encoding - Output encoding
     * @returns {string|Buffer} - 4-byte checksum
     */
    checksumHash(payload, encoding = 'hex') {
        const hash = this.hash256(payload, 'buffer');
        const checksum = hash.slice(0, 4);
        return this._formatOutput(checksum, encoding);
    }

    // ========================================
    // 8. HASH FUNCTIONS FOR BLOCKS
    // ========================================

    /**
     * Hash a block header
     * @param {Object} header - Block header data
     * @param {string} encoding - Output encoding
     * @returns {string|Buffer} - Block hash
     */
    hashBlockHeader(header, encoding = 'hex') {
        try {
            // Simplified block header hashing
            const serialized = JSON.stringify(header);
            return this.hash256(serialized, encoding);
        } catch (error) {
            throw new Error(`Block header hashing failed: ${error.message}`);
        }
    }

    /**
     * Generate Merkle root from transactions
     * @param {Array} transactions - List of transaction hashes
     * @param {string} encoding - Output encoding
     * @returns {string|Buffer} - Merkle root hash
     */
    merkleRoot(transactions, encoding = 'hex') {
        try {
            if (!transactions || transactions.length === 0) {
                return this._formatOutput(Buffer.alloc(32), encoding);
            }

            // Convert all to buffers
            let hashes = transactions.map(tx => {
                if (typeof tx === 'object') {
                    return this.hashTransaction(tx, 'buffer');
                }
                return this._toBuffer(tx);
            });

            // Build Merkle tree
            while (hashes.length > 1) {
                if (hashes.length % 2 !== 0) {
                    hashes.push(hashes[hashes.length - 1]);
                }
                
                const newHashes = [];
                for (let i = 0; i < hashes.length; i += 2) {
                    const combined = Buffer.concat([hashes[i], hashes[i + 1]]);
                    newHashes.push(this.hash256(combined, 'buffer'));
                }
                hashes = newHashes;
            }

            return this._formatOutput(hashes[0], encoding);
        } catch (error) {
            throw new Error(`Merkle root generation failed: ${error.message}`);
        }
    }

    // ========================================
    // 9. FORMAT CONVERSION HELPERS
    // ========================================

    /**
     * Check if a string is valid hex
     * @param {string} str - String to check
     * @returns {boolean} - True if valid hex
     */
    isHex(str) {
        return typeof str === 'string' && /^[0-9a-fA-F]+$/.test(str) && str.length % 2 === 0;
    }

    /**
     * Get hash length in bytes for a given algorithm
     * @param {string} algorithm - Hash algorithm
     * @returns {number} - Hash length in bytes
     */
    getHashLength(algorithm) {
        const lengths = {
            sha256: 32,
            sha512: 64,
            ripemd160: 20,
            hash160: 20,
            hash256: 32,
            'hmac-sha256': 32,
            'hmac-sha512': 64
        };
        return lengths[algorithm.toLowerCase()] || 0;
    }
}

// Export class for use in the API
module.exports = HashManager;
