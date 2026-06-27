// encoding.js - Comprehensive encoding/decoding module for Bradicoin
// Place this file in the project root

const crypto = require('crypto');
const bs58 = require('bs58');
const bech32 = require('bech32');

/**
 * EncodingManager class for Bradicoin
 * Handles all encoding/decoding operations for addresses, keys, and transactions
 */
class BradicoinEncoding {
    constructor(network = 'mainnet') {
        this.network = network;
        this.versionByte = network === 'mainnet' ? 0x00 : 0x6F;
        this.hrp = network === 'mainnet' ? 'bc' : 'tb'; // Human Readable Part for Bech32
    }

    /**
     * ========================================
     * 1. BASE58 CHECK ENCODING (Bitcoin Standard)
     * ========================================
     */

    /**
     * Encodes data with Base58Check format (version byte + hash + checksum)
     * @param {Buffer} payload - Data to encode (version byte + hash)
     * @returns {string} - Base58Check encoded address
     */
    base58CheckEncode(payload) {
        try {
            // 1. Calculate double SHA-256 checksum
            const checksum = this._calculateChecksum(payload);
            
            // 2. Concatenate payload + checksum
            const dataWithChecksum = Buffer.concat([payload, checksum]);
            
            // 3. Encode with Base58
            return bs58.encode(dataWithChecksum);
        } catch (error) {
            throw new Error(`Base58Check encoding failed: ${error.message}`);
        }
    }

    /**
     * Decodes Base58Check data
     * @param {string} encoded - Base58Check encoded string
     * @returns {Object} - Decoded data with version, hash, and checksum
     */
    base58CheckDecode(encoded) {
        try {
            // 1. Decode from Base58
            const decoded = bs58.decode(encoded);
            
            // 2. Check minimum length (1 byte version + 20 bytes hash + 4 bytes checksum)
            if (decoded.length < 25) {
                throw new Error('Invalid length: must be at least 25 bytes');
            }

            // 3. Separate components
            const version = decoded[0];
            const hash = decoded.slice(1, 21); // 20 bytes
            const providedChecksum = decoded.slice(21, 25); // 4 bytes
            
            // 4. Verify checksum
            const payload = decoded.slice(0, 21);
            const calculatedChecksum = this._calculateChecksum(payload);
            
            const isValid = this._secureCompare(providedChecksum, calculatedChecksum);
            
            return {
                valid: isValid,
                version: version,
                hash: hash.toString('hex'),
                checksum: providedChecksum.toString('hex'),
                decoded: decoded
            };
        } catch (error) {
            throw new Error(`Base58Check decoding failed: ${error.message}`);
        }
    }

    /**
     * ========================================
     * 2. BECH32 / BECH32M ENCODING (SegWit)
     * ========================================
     */

    /**
     * Encodes data with Bech32 format (for SegWit addresses)
     * @param {number} witnessVersion - Witness version (0-16)
     * @param {Buffer} program - Witness program (hash)
     * @param {boolean} useBech32m - Use Bech32m (for version >= 1)
     * @returns {string} - Bech32/Bech32m encoded address
     */
    bech32Encode(witnessVersion, program, useBech32m = false) {
        try {
            // 1. Convert witness program to 5-bit words
            const words = bech32.toWords(program);
            
            // 2. Prepend witness version
            const data = [witnessVersion, ...words];
            
            // 3. Encode with Bech32 or Bech32m
            let encoded;
            if (useBech32m) {
                encoded = bech32.bech32m.encode(this.hrp, data);
            } else {
                encoded = bech32.bech32.encode(this.hrp, data);
            }
            
            return encoded;
        } catch (error) {
            throw new Error(`Bech32 encoding failed: ${error.message}`);
        }
    }

    /**
     * Decodes Bech32/Bech32m data
     * @param {string} address - Bech32/Bech32m encoded address
     * @returns {Object} - Decoded data
     */
    bech32Decode(address) {
        try {
            let decoded;
            let isBech32m = false;
            
            // 1. Try decoding as Bech32
            try {
                decoded = bech32.bech32.decode(address);
            } catch (e) {
                // 2. Try decoding as Bech32m
                try {
                    decoded = bech32.bech32m.decode(address);
                    isBech32m = true;
                } catch (e2) {
                    throw new Error('Invalid Bech32/Bech32m address');
                }
            }
            
            // 3. Validate HRP
            if (decoded.prefix !== this.hrp) {
                throw new Error(`Invalid HRP: expected ${this.hrp}, got ${decoded.prefix}`);
            }
            
            // 4. Extract witness version and program
            const witnessVersion = decoded.words[0];
            const programWords = decoded.words.slice(1);
            const program = Buffer.from(bech32.fromWords(programWords));
            
            return {
                valid: true,
                prefix: decoded.prefix,
                witnessVersion: witnessVersion,
                program: program.toString('hex'),
                programLength: program.length,
                isBech32m: isBech32m
            };
        } catch (error) {
            return {
                valid: false,
                error: error.message
            };
        }
    }

    /**
     * ========================================
     * 3. HEX ENCODING (For hashes and keys)
     * ========================================
     */

    /**
     * Converts data to hexadecimal string
     * @param {Buffer|string} data - Data to encode
     * @returns {string} - Hexadecimal string
     */
    toHex(data) {
        try {
            if (typeof data === 'string') {
                // If it's already hex, validate
                if (/^[0-9a-fA-F]+$/.test(data)) {
                    return data.toLowerCase();
                }
                // Convert string to hex
                return Buffer.from(data, 'utf8').toString('hex');
            }
            if (Buffer.isBuffer(data)) {
                return data.toString('hex');
            }
            throw new Error('Invalid data type for hex encoding');
        } catch (error) {
            throw new Error(`Hex encoding failed: ${error.message}`);
        }
    }

    /**
     * Converts hexadecimal string to Buffer
     * @param {string} hex - Hexadecimal string
     * @returns {Buffer} - Decoded Buffer
     */
    fromHex(hex) {
        try {
            if (typeof hex !== 'string') {
                throw new Error('Hex must be a string');
            }
            const cleanHex = hex.replace(/\s/g, '');
            if (!/^[0-9a-fA-F]*$/.test(cleanHex)) {
                throw new Error('Invalid hex string');
            }
            if (cleanHex.length % 2 !== 0) {
                throw new Error('Hex string must have even length');
            }
            return Buffer.from(cleanHex, 'hex');
        } catch (error) {
            throw new Error(`Hex decoding failed: ${error.message}`);
        }
    }

    /**
     * ========================================
     * 4. BASE64 ENCODING (For data transfer)
     * ========================================
     */

    /**
     * Encodes data to Base64
     * @param {Buffer|string} data - Data to encode
     * @returns {string} - Base64 encoded string
     */
    toBase64(data) {
        try {
            let buffer;
            if (typeof data === 'string') {
                buffer = Buffer.from(data, 'utf8');
            } else if (Buffer.isBuffer(data)) {
                buffer = data;
            } else {
                throw new Error('Invalid data type for Base64 encoding');
            }
            return buffer.toString('base64');
        } catch (error) {
            throw new Error(`Base64 encoding failed: ${error.message}`);
        }
    }

    /**
     * Decodes Base64 data
     * @param {string} base64 - Base64 encoded string
     * @returns {Buffer} - Decoded Buffer
     */
    fromBase64(base64) {
        try {
            if (typeof base64 !== 'string') {
                throw new Error('Base64 must be a string');
            }
            return Buffer.from(base64, 'base64');
        } catch (error) {
            throw new Error(`Base64 decoding failed: ${error.message}`);
        }
    }

    /**
     * ========================================
     * 5. ENCODING FOR SPECIFIC USE CASES
     * ========================================
     */

    /**
     * Encodes a public key to an address (Base58Check)
     * @param {Buffer} publicKey - Public key
     * @returns {string} - Encoded address
     */
    publicKeyToAddress(publicKey) {
        try {
            // 1. Calculate HASH160 (SHA-256 + RIPEMD-160)
            const sha256Hash = crypto.createHash('sha256')
                .update(publicKey)
                .digest();
            
            const ripemd160Hash = crypto.createHash('ripemd160')
                .update(sha256Hash)
                .digest();
            
            // 2. Add version byte
            const versionBuffer = Buffer.from([this.versionByte]);
            const payload = Buffer.concat([versionBuffer, ripemd160Hash]);
            
            // 3. Encode with Base58Check
            return this.base58CheckEncode(payload);
        } catch (error) {
            throw new Error(`Public key to address encoding failed: ${error.message}`);
        }
    }

    /**
     * Encodes a private key to WIF (Wallet Import Format)
     * @param {Buffer} privateKey - Private key (32 bytes)
     * @param {boolean} compressed - Whether to use compressed format
     * @returns {string} - WIF encoded private key
     */
    privateKeyToWIF(privateKey, compressed = true) {
        try {
            // 1. Add version byte (0x80 for mainnet)
            const versionBuffer = Buffer.from([0x80]);
            let payload = Buffer.concat([versionBuffer, privateKey]);
            
            // 2. Add compressed flag if needed
            if (compressed) {
                const compressionByte = Buffer.from([0x01]);
                payload = Buffer.concat([payload, compressionByte]);
            }
            
            // 3. Encode with Base58Check
            return this.base58CheckEncode(payload);
        } catch (error) {
            throw new Error(`WIF encoding failed: ${error.message}`);
        }
    }

    /**
     * Decodes WIF (Wallet Import Format) to private key
     * @param {string} wif - WIF encoded private key
     * @returns {Object} - Decoded private key data
     */
    wifToPrivateKey(wif) {
        try {
            // 1. Decode from Base58Check
            const decoded = bs58.decode(wif);
            
            // 2. Extract version
            const version = decoded[0];
            if (version !== 0x80) {
                throw new Error(`Invalid WIF version: expected 0x80, got ${version}`);
            }
            
            // 3. Extract private key
            const privateKey = decoded.slice(1, 33);
            
            // 4. Check if compressed
            const isCompressed = decoded.length === 34 && decoded[33] === 0x01;
            
            return {
                valid: true,
                privateKey: privateKey.toString('hex'),
                compressed: isCompressed,
                version: version
            };
        } catch (error) {
            return {
                valid: false,
                error: error.message
            };
        }
    }

    /**
     * ========================================
     * 6. UTILITY FUNCTIONS
     * ========================================
     */

    /**
     * Calculates double SHA-256 checksum (4 bytes)
     * @private
     */
    _calculateChecksum(payload) {
        const firstHash = crypto.createHash('sha256')
            .update(payload)
            .digest();
        
        const secondHash = crypto.createHash('sha256')
            .update(firstHash)
            .digest();
        
        return secondHash.slice(0, 4);
    }

    /**
     * Secure buffer comparison
     * @private
     */
    _secureCompare(a, b) {
        if (!Buffer.isBuffer(a) || !Buffer.isBuffer(b)) {
            return false;
        }
        if (a.length !== b.length) {
            return false;
        }
        
        try {
            return crypto.timingSafeEqual(a, b);
        } catch (error) {
            let result = 0;
            for (let i = 0; i < a.length; i++) {
                result |= a[i] ^ b[i];
            }
            return result === 0;
        }
    }

    /**
     * Validates if a string is a valid address
     * @param {string} address - Address to validate
     * @returns {Object} - Validation result
     */
    validateAddressFormat(address) {
        try {
            // 1. Try Base58Check format
            if (address.length >= 26 && address.length <= 35) {
                const decoded = this.base58CheckDecode(address);
                if (decoded.valid) {
                    return {
                        valid: true,
                        format: 'Base58Check',
                        version: decoded.version,
                        hash: decoded.hash
                    };
                }
            }
            
            // 2. Try Bech32 format
            if (address.startsWith(this.hrp)) {
                const decoded = this.bech32Decode(address);
                if (decoded.valid) {
                    return {
                        valid: true,
                        format: decoded.isBech32m ? 'Bech32m' : 'Bech32',
                        witnessVersion: decoded.witnessVersion,
                        program: decoded.program
                    };
                }
            }
            
            return {
                valid: false,
                error: 'Invalid address format'
            };
        } catch (error) {
            return {
                valid: false,
                error: error.message
            };
        }
    }

    /**
     * Detects address type from encoded string
     * @param {string} address - Address to analyze
     * @returns {Object} - Address type information
     */
    detectAddressType(address) {
        const result = {
            type: 'unknown',
            network: 'unknown',
            format: 'unknown'
        };

        try {
            // Check network by prefix
            if (address.startsWith('1') || address.startsWith('3')) {
                result.network = 'mainnet';
                result.format = 'Base58Check';
                result.type = address.startsWith('1') ? 'P2PKH' : 'P2SH';
            } else if (address.startsWith('m') || address.startsWith('n')) {
                result.network = 'testnet';
                result.format = 'Base58Check';
                result.type = address.startsWith('m') ? 'P2PKH' : 'P2SH';
            } else if (address.startsWith(this.hrp)) {
                result.network = this.network;
                result.format = 'Bech32';
                result.type = 'SegWit';
            }

            return result;
        } catch (error) {
            return result;
        }
    }
}

// Export class for use in the API
module.exports = BradicoinEncoding;
