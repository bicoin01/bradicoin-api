// services/buy/depositAddress.js
// ============================================
// Gerador de endereço de depósito por pedido (HD wallet)
// ============================================
// Usa BUY_MASTER_SEED (BIP39) pra derivar um endereço ÚNICO
// por pedido, no índice BUY_HD_INDEX_START + depositIndex.
//
// ⚠️ É o coração do sistema: sem isso, todos os pedidos
//    cairiam no mesmo endereço e o monitor não conseguiria
//    distinguir de quem é cada pagamento.
// ============================================

const { ethers } = require('ethers');
const { logger } = require('../../middleware/error');

// ===== CONFIG =====
const MASTER_SEED = process.env.BUY_MASTER_SEED || null;
const HD_INDEX_START = parseInt(process.env.BUY_HD_INDEX_START || '1000', 10);
const HD_INDEX_END = parseInt(process.env.BUY_HD_INDEX_END || '9999', 10);

// ===== ESTADO =====
let masterNode = null;

// ============================================
// INICIALIZA O NÓ MESTRE (uma vez só)
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

    // ethers v6: HDNodeWallet.fromPhrase() sem path = nó raiz
    masterNode = ethers.HDNodeWallet.fromPhrase(MASTER_SEED);
    logger.info('[depositAddress] Master node HD inicializado');
    return masterNode;
}

// ============================================
// DERIVA ENDEREÇO POR (REDE, ÍNDICE)
// ============================================
// BIP44 paths:
//   ETH / BNB (EVM)  → m/44'/60'/0'/0/{index}
//   USDT-ERC20/BEP20 → mesma do EVM (é só um token, mesma carteira)
//
// ⚠️ BTC e SOL serão adicionados depois (fase 2). Por enquanto
//    só EVM (Ethereum + BSC) é suportado.
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

    // derivePath retorna HDNodeWallet, .address é o endereço EVM
    const child = root.derivePath(path);
    return ethers.getAddress(child.address); // checksum
}

// ============================================
// API PÚBLICA
// ============================================

/**
 * Gera o endereço de depósito pra um pedido.
 *
 * @param {string} currency       'BNB' | 'ETH' | 'USDT' (fase 1: BNB/USDT-BEP20)
 * @param {string|null} network   'bsc' | 'ethereum' | null
 * @param {number} depositIndex   índice HD reservado pro pedido
 * @returns {string}              endereço (0x...)
 */
function generateDepositAddress(currency, network, depositIndex) {
    if (!Number.isInteger(depositIndex)) {
        throw new Error('depositIndex deve ser inteiro');
    }

    const c = String(currency || '').toUpperCase();
    const n = String(network || '').toLowerCase();

    // Fase 1: só EVM (BNB nativo, USDT-BEP20, ETH, USDT-ERC20)
    if (c === 'BNB' || c === 'ETH' || c === 'USDT') {
        // USDT tem rede obrigatória
        if (c === 'USDT' && !['bsc', 'ethereum'].includes(n)) {
            throw new Error(
                `USDT precisa de rede 'bsc' ou 'ethereum' (recebido: '${n}'). ` +
                `USDT-TRC20/SOL virão na fase 2.`
            );
        }
        return deriveEvmAddress(depositIndex);
    }

    throw new Error(
        `Moeda '${c}' não suportada ainda. Fase 1: BNB, ETH, USDT (bsc/ethereum).`
    );
}

/**
 * Resolve o próximo índice HD livre pra um pedido novo.
 * Estratégia: encontrar o maior depositIndex usado e somar 1.
 * Se nenhum ainda, começa em BUY_HD_INDEX_START.
 *
 * ⚠️ Precisa ser chamado ANTES de criar o BuyOrder, de preferência
 *    com um lock (findOneAndUpdate) pra evitar corrida entre dois
 *    pedidos simultâneos pegando o mesmo índice.
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
 * Validação rápida (chamada no boot) — confere que a seed
 * bate com o endereço esperado no índice inicial.
 * Não deriva todos, só o primeiro, pra detectar seed trocada.
 */
function selfTest() {
    try {
        const root = getMasterNode();
        const first = root.derivePath(`m/44'/60'/0'/0/${HD_INDEX_START}`);
        logger.info(
            `[depositAddress] OK — seed válida, ` +
            `índice ${HD_INDEX_START} → ${first.address}`
        );
        return true;
    } catch (err) {
        logger.error(`[depositAddress] FALHOU selfTest: ${err.message}`);
        return false;
    }
}

// ============================================
// EXPORT
// ============================================
module.exports = {
    generateDepositAddress,
    nextDepositIndex,
    selfTest,
    deriveEvmAddress
};
