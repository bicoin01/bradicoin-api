// services/buy/depositAddress.js
// ============================================
// Gerador de endereço de depósito por pedido (HD wallet)
// ============================================
// Usa BUY_MASTER_SEED (BIP39) pra derivar um endereço ÚNICO
// por pedido, no índice BUY_HD_INDEX_START + depositIndex.
//
// Suporta:
//   - EVM (ETH, BNB, USDT-ERC20, USDT-BEP20) → BIP44 m/44'/60'/0'/0/{i}
//   - Solana (SOL) → BIP44 m/44'/501'/{i}'/0' (Ed25519)
//
// ⚠️ BTC fica pra fase 2 (precisa bitcoinjs-lib + bip32 + bip84).
// ============================================

const { ethers } = require('ethers');
const { logger } = require('../../middleware/error');

// ===== CONFIG =====
const MASTER_SEED = process.env.BUY_MASTER_SEED || null;
const HD_INDEX_START = parseInt(process.env.BUY_HD_INDEX_START || '1000', 10);
const HD_INDEX_END = parseInt(process.env.BUY_HD_INDEX_END || '9999', 10);

// ===== ESTADO =====
let masterNode = null;
let solMasterSeed = null;
let solLibs = null; // { derivePath, bip39, Keypair }

// ============================================
// INICIALIZA O NÓ MESTRE EVM (uma vez só)
// ============================================
function getMasterNode() {
    if (masterNode) return masterNode;

    if (!MASTER_SEED) {
        throw new Error(
            'BUY_MASTER_SEED não configurada no .env. ' +
            'Rode: node scripts/generate-buy-wallets.js'
        );
    }

    if (!ethers.Mnemonic.isValidMnemonic(MASTER_SEED)) {
        throw new Error('BUY_MASTER_SEED inválida (não é BIP39)');
    }

    masterNode = ethers.HDNodeWallet.fromPhrase(MASTER_SEED);
    logger.info('[depositAddress] Master node EVM inicializado');
    return masterNode;
}

// ============================================
// INICIALIZA SEED SOLANA (uma vez só)
// ============================================
function getSolLibs() {
    if (solLibs) return solLibs;

    let derivePath, bip39, Keypair;
    try {
        ({ derivePath } = require('ed25519-hd-key'));
        bip39 = require('bip39');
        ({ Keypair } = require('@solana/web3.js'));
    } catch (err) {
        throw new Error(
            'Dependências Solana não instaladas. Rode: ' +
            'npm install @solana/web3.js bip39 ed25519-hd-key. ' +
            `(${err.message})`
        );
    }

    if (!MASTER_SEED) {
        throw new Error('BUY_MASTER_SEED não configurada');
    }
    if (!bip39.validateMnemonic(MASTER_SEED)) {
        throw new Error('BUY_MASTER_SEED inválida (bip39)');
    }

    solMasterSeed = bip39.mnemonicToSeedSync(MASTER_SEED);

    solLibs = { derivePath, bip39, Keypair };
    logger.info('[depositAddress] Master node Solana inicializado');
    return solLibs;
}

// ============================================
// DERIVA ENDEREÇO EVM (ETH/BNB/USDT)
// ============================================
function deriveEvmAddress(index) {
    if (index < HD_INDEX_START || index > HD_INDEX_END) {
        throw new Error(
            `Índice HD fora do range permitido: ${index} ` +
            `(range: ${HD_INDEX_START}–${HD_INDEX_END})`
        );
    }

    const root = getMasterNode();
    const path = `m/44'/60'/0'/0/${index}`;

    const child = root.derivePath(path);
    return ethers.getAddress(child.address); // checksum
}

// ============================================
// DERIVA ENDEREÇO SOLANA (base58)
// ============================================
function deriveSolAddress(index) {
    if (index < HD_INDEX_START || index > HD_INDEX_END) {
        throw new Error(
            `Índice HD fora do range permitido: ${index} ` +
            `(range: ${HD_INDEX_START}–${HD_INDEX_END})`
        );
    }

    const { derivePath, Keypair } = getSolLibs();

    const path = `m/44'/501'/${index}'/0'`;
    const seedHex = Buffer.from(solMasterSeed).toString('hex');
    const derived = derivePath(path, seedHex);
    const keypair = Keypair.fromSeed(derived.key);

    return keypair.publicKey.toBase58();
}

// ============================================
// API PÚBLICA
// ============================================

/**
 * Gera o endereço de depósito pra um pedido.
 *
 * @param {string} currency       'BNB' | 'ETH' | 'SOL' | 'USDT'
 * @param {string|null} network   'bsc' | 'ethereum' | 'solana'
 * @param {number} depositIndex   índice HD reservado pro pedido
 * @returns {string}              endereço (EVM 0x... ou Solana base58)
 */
function generateDepositAddress(currency, network, depositIndex) {
    if (!Number.isInteger(depositIndex)) {
        throw new Error('depositIndex deve ser inteiro');
    }

    const c = String(currency || '').toUpperCase();
    const n = String(network || '').toLowerCase();

    // ===== Solana =====
    if (c === 'SOL') {
        if (n && n !== 'solana') {
            throw new Error(`SOL só suporta rede 'solana' (recebido: '${n}')`);
        }
        return deriveSolAddress(depositIndex);
    }

    // ===== EVM (ETH / BNB / USDT) =====
    if (c === 'BNB' || c === 'ETH' || c === 'USDT') {
        if (c === 'USDT' && !['bsc', 'ethereum'].includes(n)) {
            throw new Error(
                `USDT precisa de rede 'bsc' ou 'ethereum' (recebido: '${n}'). ` +
                `USDT-TRC20/SOL virão na fase 2.`
            );
        }
        return deriveEvmAddress(depositIndex);
    }

    // ===== BTC — fase 2 =====
    if (c === 'BTC') {
        throw new Error(
            'BTC ainda não implementado no depositAddress. ' +
            'Instale bitcoinjs-lib + bip32 + bip84 e implemente deriveBtcAddress().'
        );
    }

    throw new Error(`Moeda '${c}' não suportada`);
}

/**
 * Resolve o próximo índice HD livre pra um pedido novo.
 * Estratégia: encontrar o maior depositIndex usado e somar 1.
 * Se nenhum ainda, começa em BUY_HD_INDEX_START.
 */
async function nextDepositIndex() {
    const BuyOrder = require('../../models/BuyOrder');

    const last = await BuyOrder.findOne(
        { depositIndex: { $ne: null } },
        { depositIndex: 1 },
        { sort: { depositIndex: -1 } }
    ).lean();

    const next = last && Number.isInteger(last.depositIndex)
        ? last.depositIndex + 1
        : HD_INDEX_START;

    if (next > HD_INDEX_END) {
        throw new Error(
            `Range HD esgotado (${HD_INDEX_START}–${HD_INDEX_END}). ` +
            `Aumente BUY_HD_INDEX_END no .env e rode novo script.`
        );
    }

    return next;
}

/**
 * Validação rápida (chamada no boot) — confere EVM + Solana.
 */
function selfTest() {
    try {
        const root = getMasterNode();
        const first = root.derivePath(`m/44'/60'/0'/0/${HD_INDEX_START}`);
        logger.info(
            `[depositAddress] EVM OK — índice ${HD_INDEX_START} → ${first.address}`
        );
    } catch (err) {
        logger.error(`[depositAddress] FALHOU EVM selfTest: ${err.message}`);
        return false;
    }

    try {
        // Só testa se BUY_SOL_ENABLED !== 'false' (evita erro se libs Solana não instaladas)
        if (process.env.BUY_SOL_ENABLED !== 'false') {
            const solAddr = deriveSolAddress(HD_INDEX_START);
            logger.info(
                `[depositAddress] SOL OK — índice ${HD_INDEX_START} → ${solAddr}`
            );
        }
    } catch (err) {
        logger.warn(`[depositAddress] SOL selfTest falhou: ${err.message}`);
        // Não aborta boot se SOL falhar — só BNB é crítico na fase 1
    }

    return true;
}

// ============================================
// EXPORT
// ============================================
module.exports = {
    generateDepositAddress,
    nextDepositIndex,
    selfTest,
    deriveEvmAddress,
    deriveSolAddress
};
