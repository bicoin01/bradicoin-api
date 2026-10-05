// atomic-swap/security/secretManager.js
// ============================================
// SecretManager — Gera, armazena e valida preimages
// ============================================
// ⚠️ Em produção: criptografar com KMS / HSM / hardware wallet
// ============================================

const crypto = require('crypto');
const { sha256 } = require('@noble/hashes/sha2');
const { bytesToHex, utf8ToBytes } = require('@noble/hashes/utils');

function generateSecret() {
    return crypto.randomBytes(32).toString('hex');
}

function hashSecret(secret) {
    if (!secret) throw new Error('secret obrigatório');
    return bytesToHex(sha256(utf8ToBytes(secret)));
}

function verifySecret(secret, hashlock) {
    if (!secret || !hashlock) return false;
    try {
        const computed = hashSecret(secret);
        return computed.toLowerCase() === hashlock.toLowerCase();
    } catch (_) {
        return false;
    }
}

// ⚠️ Placeholder — em prod use AES-256-GCM com chave do KMS
function encrypt(plaintext, key = process.env.SECRET_KEY) {
    if (!key) throw new Error('SECRET_KEY não configurada');
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(key, 'hex').slice(0, 32), iv);
    const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return iv.toString('hex') + ':' + tag.toString('hex') + ':' + enc.toString('hex');
}

function decrypt(ciphertext, key = process.env.SECRET_KEY) {
    if (!key) throw new Error('SECRET_KEY não configurada');
    const [ivHex, tagHex, encHex] = ciphertext.split(':');
    const decipher = crypto.createDecipheriv(
        'aes-256-gcm',
        Buffer.from(key, 'hex').slice(0, 32),
        Buffer.from(ivHex, 'hex')
    );
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    const dec = Buffer.concat([decipher.update(Buffer.from(encHex, 'hex')), decipher.final()]);
    return dec.toString('utf8');
}

module.exports = {
    generateSecret,
    hashSecret,
    verifySecret,
    encrypt,
    decrypt
};
