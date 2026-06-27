// validator.js - Validation module for Bradicoin API
// Place this file in the project root

const crypto = require('crypto');
const bs58 = require('bs58');

/**
 * Validator Class for Bradicoin
 * Validates addresses, transactions, keys and blockchain data
 */
class BradicoinValidator {
    constructor(network = 'mainnet') {
        this.network = network;
        // Version byte: 0x00 for Mainnet, 0x6F for Testnet
        this.versionByte = network === 'mainnet' ? 0x00 : 0x6F;
    }

    /**
     * ADDRESS VALIDATION
     * Checks if a Bradicoin address is valid (Base58Check format)
     */
    validateAddress(address) {
        try {
            // 1. Check if it's a string and has minimum length
            if (typeof address !== 'string' || address.length < 26 || address.length > 35) {
                return { valid: false, error: 'Address must be between 26 and 35 characters' };
            }

            // 2. Decode from Base58
            const decoded = bs58.decode(address);
            
            // 3. Check minimum size (1 byte version + 20 bytes hash + 4 bytes checksum = 25 bytes)
            if (decoded.length !== 25) {
                return { valid: false, error: 'Decoded address must be 25 bytes' };
            }

            // 4. Check version byte
            const version = decoded[0];
            if (version !== this.versionByte) {
                return { 
                    valid: false, 
                    error: `Invalid version byte for ${this.network}. Expected: ${this.versionByte}, received: ${version}` 
                };
            }

            // 5. Verify checksum
            const payload = decoded.slice(0, 21); // 1 byte version + 20 bytes hash
            const checksum = decoded.slice(21, 25); // 4 bytes checksum
            
            const calculatedChecksum = crypto.createHash('sha256')
                .update(crypto.createHash('sha256')
                    .update(payload)
                    .digest()
                )
                .digest()
                .slice(0, 4);

            if (!checksum.equals(calculatedChecksum)) {
                return { valid: false, error: 'Invalid checksum - address may have been typed incorrectly' };
            }

            return { valid: true, version, hash: payload.slice(1) };
        } catch (error) {
            return { valid: false, error: `Error validating address: ${error.message}` };
        }
    }

    /**
     * PRIVATE KEY VALIDATION
     * Checks if a private key is valid (32 bytes in hex or base64)
     */
    validatePrivateKey(privateKey) {
        try {
            // 1. Check if it's a string
            if (typeof privateKey !== 'string') {
                return { valid: false, error: 'Private key must be a string' };
            }

            // 2. Remove spaces and check format
            const cleanKey = privateKey.trim();
            
            // 3. Try to decode from hex (64 characters = 32 bytes)
            let keyBuffer;
            if (/^[0-9a-fA-F]{64}$/.test(cleanKey)) {
                keyBuffer = Buffer.from(cleanKey, 'hex');
            } 
            // 4. Try to decode from base64
            else {
                try {
                    keyBuffer = Buffer.from(cleanKey, 'base64');
                    if (keyBuffer.length !== 32) {
                        return { valid: false, error: 'Private key must be 32 bytes (64 hex characters)' };
                    }
                } catch (e) {
                    return { valid: false, error: 'Invalid format. Use hex (64 characters) or base64' };
                }
            }

            // 5. Check size
            if (keyBuffer.length !== 32) {
                return { valid: false, error: 'Private key must be exactly 32 bytes' };
            }

            // 6. Check if it's not zero or invalid for secp256k1
            const isZero = keyBuffer.every(byte => byte === 0);
            if (isZero) {
                return { valid: false, error: 'Private key cannot be all zeros' };
            }

            // Check if it's within valid range for secp256k1 (1 to n-1)
            // n = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141
            const maxKey = Buffer.from('FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141', 'hex');
            if (keyBuffer.compare(maxKey) >= 0) {
                return { valid: false, error: 'Private key outside allowed range for secp256k1' };
            }

            return { valid: true, keyBuffer };
        } catch (error) {
            return { valid: false, error: `Error validating private key: ${error.message}` };
        }
    }

    /**
     * PUBLIC KEY VALIDATION
     * Checks if a public key is valid (uncompressed format 0x04 + X + Y)
     */
    validatePublicKey(publicKey) {
        try {
            // 1. Check if it's a string
            if (typeof publicKey !== 'string') {
                return { valid: false, error: 'Public key must be a string' };
            }

            const cleanKey = publicKey.trim();
            
            // 2. Try to decode from hex
            let keyBuffer;
            try {
                keyBuffer = Buffer.from(cleanKey, 'hex');
            } catch (e) {
                return { valid: false, error: 'Public key must be in hexadecimal format' };
            }

            // 3. Check size (uncompressed = 65 bytes, compressed = 33 bytes)
            if (keyBuffer.length === 65) {
                // Uncompressed format: 0x04 + X (32 bytes) + Y (32 bytes)
                if (keyBuffer[0] !== 0x04) {
                    return { valid: false, error: 'Uncompressed public key must start with 0x04' };
                }
            } else if (keyBuffer.length === 33) {
                // Compressed format: 0x02 or 0x03 + X (32 bytes)
                if (keyBuffer[0] !== 0x02 && keyBuffer[0] !== 0x03) {
                    return { valid: false, error: 'Compressed public key must start with 0x02 or 0x03' };
                }
            } else {
                return { valid: false, error: 'Public key must be 33 (compressed) or 65 (uncompressed) bytes' };
            }

            return { valid: true, keyBuffer };
        } catch (error) {
            return { valid: false, error: `Error validating public key: ${error.message}` };
        }
    }

    /**
     * TRANSACTION HASH (TXID) VALIDATION
     * Checks if the transaction hash is valid
     */
    validateTransactionHash(txHash) {
        try {
            // 1. Check if it's a string
            if (typeof txHash !== 'string') {
                return { valid: false, error: 'Transaction hash must be a string' };
            }

            const cleanHash = txHash.trim();

            // 2. Check if it's hex and has 64 characters (32 bytes)
            if (!/^[0-9a-fA-F]{64}$/.test(cleanHash)) {
                return { valid: false, error: 'Hash must be 64 hexadecimal characters (32 bytes)' };
            }

            // 3. Check if it's not zero
            const hashBuffer = Buffer.from(cleanHash, 'hex');
            const isZero = hashBuffer.every(byte => byte === 0);
            if (isZero) {
                return { valid: false, error: 'Transaction hash cannot be all zeros' };
            }

            return { valid: true, hashBuffer };
        } catch (error) {
            return { valid: false, error: `Error validating transaction hash: ${error.message}` };
        }
    }

    /**
     * AMOUNT VALIDATION
     * Checks if the value is valid for transactions
     */
    validateAmount(amount, minAmount = 0) {
        try {
            // 1. Check if it's a number
            if (typeof amount !== 'number' && typeof amount !== 'string') {
                return { valid: false, error: 'Amount must be a number or string' };
            }

            // 2. Convert to number
            const numAmount = typeof amount === 'string' ? parseFloat(amount) : amount;
            
            // 3. Check if it's NaN
            if (isNaN(numAmount)) {
                return { valid: false, error: 'Invalid amount' };
            }

            // 4. Check if it's positive
            if (numAmount <= 0) {
                return { valid: false, error: 'Amount must be greater than zero' };
            }

            // 5. Check minimum
            if (numAmount < minAmount) {
                return { valid: false, error: `Minimum amount is ${minAmount}` };
            }

            // 6. Check maximum decimal places (8 for Bitcoin/Bradicoin)
            const decimalPlaces = (numAmount.toString().split('.')[1] || '').length;
            if (decimalPlaces > 8) {
                return { valid: false, error: 'Amount cannot have more than 8 decimal places' };
            }

            return { valid: true, amount: numAmount };
        } catch (error) {
            return { valid: false, error: `Error validating amount: ${error.message}` };
        }
    }

    /**
     * FEE VALIDATION
     * Checks if the fee is valid
     */
    validateFee(fee, maxFee = 0.01) {
        try {
            const feeValidation = this.validateAmount(fee, 0);
            if (!feeValidation.valid) {
                return feeValidation;
            }

            // Check if fee is not too high (security)
            if (feeValidation.amount > maxFee) {
                return { valid: false, error: `Fee too high. Maximum allowed: ${maxFee}` };
            }

            return { valid: true, fee: feeValidation.amount };
        } catch (error) {
            return { valid: false, error: `Error validating fee: ${error.message}` };
        }
    }

    /**
     * IP ADDRESS VALIDATION FOR NODES
     * Checks if the IP is valid for node connection
     */
    validateNodeIP(ip) {
        try {
            // Simple regex for IPv4 and IPv6
            const ipv4Regex = /^(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
            const ipv6Regex = /^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))$/;

            if (!ipv4Regex.test(ip) && !ipv6Regex.test(ip)) {
                return { valid: false, error: 'Invalid IP format' };
            }

            return { valid: true };
        } catch (error) {
            return { valid: false, error: `Error validating IP: ${error.message}` };
        }
    }
}

// Export instance for use in the API
module.exports = BradicoinValidator;
