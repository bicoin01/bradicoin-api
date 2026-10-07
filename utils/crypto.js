// utils/crypto.js
// ============================================
// Criptografia de chaves privadas - Bradicoin
// ============================================
// Uso pessoal: criptografia AES-256-GCM com MASTER_KEY do .env
// ============================================

const crypto = require('crypto');

const ALGO = 'aes-256-gcm';

function getMasterKey() {
    const masterKey = process.env.MASTER_KEY;
    if (!masterKey || masterKey.length < 32) {
        throw new Error('❌ MASTER_KEY não configurada ou muito curta (min 32 chars)');
    }
    return crypto.createHash('sha256').update(masterKey).digest();
}

function encrypt(plaintext) {
    const key = getMasterKey();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(ALGO, key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

function decrypt(ciphertext) {
    if (!ciphertext || typeof ciphertext !== 'string') {
        throw new Error('Ciphertext inválido');
    }
    const parts = ciphertext.split(':');
    if (parts.length !== 3) {
        throw new Error('Formato de ciphertext inválido');
    }
    const [ivHex, tagHex, dataHex] = parts;
    const key = getMasterKey();
    const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    return Buffer.concat([
        decipher.update(Buffer.from(dataHex, 'hex')),
        decipher.final()
    ]).toString('utf8');
}

module.exports = { encrypt, decrypt };
