// checksum.js - Exclusive module for Bradicoin Checksum management
// Place this file in the project root

const crypto = require('crypto');
const bs58 = require('bs58');

/**
 * ChecksumManager class for Bradicoin
 * Manages creation and verification of checksums for addresses and transactions
 */
class BradicoinChecksum {
    constructor() {
        this.checksumLength = 4; // 4 bytes for checksum (Bitcoin standard)
    }

    /**
     * Calculates the checksum of a payload (double SHA-256)
     * @param {Buffer} payload - Data to calculate the checksum
     * @returns {Buffer} - 4-byte checksum
     */
    calculateChecksum(payload) {
        try {
            // Double SHA-256: SHA256(SHA256(payload))
            const firstHash = crypto.createHash('sha256')
                .update(payload)
                .digest();
            
            const secondHash = crypto.createHash('sha256')
                .update(firstHash)
                .digest();
            
            // Get the first 4 bytes of the second hash
            return secondHash.slice(0, this.checksumLength);
        } catch (error) {
            throw new Error(`Error calculating checksum: ${error.message}`);
        }
    }

    /**
     * Verifies if an address checksum is valid
     * @param {string} address - Complete address (Base58Check)
     * @returns {Object} - Verification result
     */
    verifyAddressChecksum(address) {
        try {
            // 1. Decode address from Base58
            const decoded = bs58.decode(address);
            
            // 2. Check minimum size (1 byte version + 20 bytes hash + 4 bytes checksum)
            if (decoded.length !== 25) {
                return {
                    valid: false,
                    error: 'Address must be 25 bytes after decoding',
                    details: `Current size: ${decoded.length} bytes`
                };
            }

            // 3. Separate payload (version + hash) and checksum
            const payload = decoded.slice(0, 21); // 1 byte version + 20 bytes hash
            const providedChecksum = decoded.slice(21, 25); // 4 bytes checksum

            // 4. Calculate the expected checksum
            const calculatedChecksum = this.calculateChecksum(payload);

            // 5. Compare checksums (using time-safe comparison)
            const isValid = this.secureCompare(providedChecksum, calculatedChecksum);

            return {
                valid: isValid,
                providedChecksum: providedChecksum.toString('hex'),
                calculatedChecksum: calculatedChecksum.toString('hex'),
                payload: payload.toString('hex')
            };
        } catch (error) {
            return {
                valid: false,
                error: `Error verifying checksum: ${error.message}`
            };
        }
    }

    /**
     * Generates a complete address with checksum
     * @param {Buffer} versionByte - Network version byte
     * @param {Buffer} hash160 - 20-byte hash of the public key
     * @returns {string} - Complete address in Base58Check format
     */
    generateAddressWithChecksum(versionByte, hash160) {
        try {
            // 1. Validate inputs
            if (!Buffer.isBuffer(versionByte) || versionByte.length !== 1) {
                throw new Error('Version byte must be a 1-byte Buffer');
            }
            if (!Buffer.isBuffer(hash160) || hash160.length !== 20) {
                throw new Error('Hash160 must be a 20-byte Buffer');
            }

            // 2. Concatenate version + hash
            const payload = Buffer.concat([versionByte, hash160]);

            // 3. Calculate checksum
            const checksum = this.calculateChecksum(payload);

            // 4. Concatenate payload + checksum
            const addressBytes = Buffer.concat([payload, checksum]);

            // 5. Encode in Base58
            return bs58.encode(addressBytes);
        } catch (error) {
            throw new Error(`Error generating address with checksum: ${error.message}`);
        }
    }

    /**
     * Secure buffer comparison (protected against timing attacks)
     * @param {Buffer} a - First buffer
     * @param {Buffer} b - Second buffer
     * @returns {boolean} - True if buffers are equal
     */
    secureCompare(a, b) {
        if (!Buffer.isBuffer(a) || !Buffer.isBuffer(b)) {
            return false;
        }
        if (a.length !== b.length) {
            return false;
        }
        
        // Use crypto.timingSafeEqual for secure comparison
        try {
            return crypto.timingSafeEqual(a, b);
        } catch (error) {
            // Fallback in case crypto.timingSafeEqual is not available
            let result = 0;
            for (let i = 0; i < a.length; i++) {
                result |= a[i] ^ b[i];
            }
            return result === 0;
        }
    }

    /**
     * Validates and fixes an address (if possible)
     * @param {string} address - Address to verify
     * @returns {Object} - Validation result with correction suggestion
     */
    validateAndFixAddress(address) {
        try {
            // 1. Check current checksum
            const verification = this.verifyAddressChecksum(address);
            
            if (verification.valid) {
                return {
                    valid: true,
                    address: address,
                    message: 'Valid address'
                };
            }

            // 2. Try to fix: decode, recalculate checksum and re-encode
            const decoded = bs58.decode(address);
            if (decoded.length === 25) {
                const payload = decoded.slice(0, 21);
                const correctedChecksum = this.calculateChecksum(payload);
                const correctedBytes = Buffer.concat([payload, correctedChecksum]);
                const correctedAddress = bs58.encode(correctedBytes);
                
                return {
                    valid: false,
                    originalAddress: address,
                    correctedAddress: correctedAddress,
                    message: 'Invalid address. Corrected version available.',
                    error: verification.error
                };
            }

            return {
                valid: false,
                error: 'Could not fix the address',
                details: verification
            };
        } catch (error) {
            return {
                valid: false,
                error: `Error validating/fixing address: ${error.message}`
            };
        }
    }

    /**
     * Generates a checksum for transactions (TXID)
     * @param {Object} transactionData - Transaction data
     * @returns {string} - Transaction hash with checksum
     */
    generateTransactionChecksum(transactionData) {
        try {
            // 1. Serialize transaction data
            const serializedData = JSON.stringify(transactionData);
            const dataBuffer = Buffer.from(serializedData, 'utf8');

            // 2. Calculate transaction hash
            const txHash = crypto.createHash('sha256')
                .update(dataBuffer)
                .digest();

            // 3. Calculate transaction checksum
            const checksum = this.calculateChecksum(txHash);

            // 4. Return full hash with checksum
            return {
                transactionHash: txHash.toString('hex'),
                transactionChecksum: checksum.toString('hex'),
                fullHash: Buffer.concat([txHash, checksum]).toString('hex')
            };
        } catch (error) {
            throw new Error(`Error generating transaction checksum: ${error.message}`);
        }
    }

    /**
     * Verifies if a transaction hash is valid
     * @param {string} fullHash - Complete hash with checksum
     * @returns {Object} - Verification result
     */
    verifyTransactionChecksum(fullHash) {
        try {
            // 1. Convert from hex to buffer
            const hashBuffer = Buffer.from(fullHash, 'hex');
            
            // 2. Separate hash and checksum (32 bytes hash + 4 bytes checksum)
            if (hashBuffer.length !== 36) {
                return {
                    valid: false,
                    error: 'Hash must be 36 bytes (32 hash + 4 checksum)'
                };
            }

            const transactionHash = hashBuffer.slice(0, 32);
            const providedChecksum = hashBuffer.slice(32, 36);

            // 3. Calculate expected checksum
            const calculatedChecksum = this.calculateChecksum(transactionHash);

            // 4. Compare checksums
            const isValid = this.secureCompare(providedChecksum, calculatedChecksum);

            return {
                valid: isValid,
                transactionHash: transactionHash.toString('hex'),
                providedChecksum: providedChecksum.toString('hex'),
                calculatedChecksum: calculatedChecksum.toString('hex')
            };
        } catch (error) {
            return {
                valid: false,
                error: `Error verifying transaction checksum: ${error.message}`
            };
        }
    }
}

// Export class for use in the API
module.exports = BradicoinChecksum;
