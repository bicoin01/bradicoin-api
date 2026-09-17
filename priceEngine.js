// priceEngine.js

// ============================================
// 💰 MOTOR DE PREÇO DINÂMICO
// ============================================

const BASE_PRICE = 10.00;        // Piso ($10)
const MAX_PRICE = 50.00;         // Teto ($50)
const SMOOTHING = 0.3;           // Suavização (0.1 = lento, 0.9 = rápido)

let currentPrice = 12.47;        // Preço inicial
let lastUpdate = Date.now();
const priceHistory = [];         // Últimas 100 variações

/**
 * Calcula o novo preço baseado na atividade da rede
 * 
 * @param {Object} activity - Dados de atividade
 * @param {number} activity.tx24h - Transações nas últimas 24h
 * @param {number} activity.stakingAmount - Total em staking
 * @param {number} activity.newWallets - Novas wallets hoje
 * @param {number} activity.burnedAmount - Total queimado
 * @returns {number} Novo preço atual
 */
function calculatePrice(activity = {}) {
    const {
        tx24h = 0,
        stakingAmount = 0,
        newWallets = 0,
        burnedAmount = 0
    } = activity;

    // ============================================
    // 1. FATOR: Volume de transações (peso 40%)
    // ============================================
    // Baseline: 1000 TX/dia = neutro
    // Mais TX = preço sobe até 15% por esse fator
    const txFactor = Math.min((tx24h / 1000) * 0.15, 0.15);

    // ============================================
    // 2. FATOR: Staking (peso 30%)
    // ============================================
    // Baseline: 10M BRD em staking = neutro
    // Mais staking = preço sobe até 10%
    const stakingFactor = Math.min((stakingAmount / 10000000) * 0.10, 0.10);

    // ============================================
    // 3. FATOR: Novas wallets (peso 20%)
    // ============================================
    // Baseline: 100 wallets/dia = neutro
    // Mais wallets = preço sobe até 5%
    const walletFactor = Math.min((newWallets / 100) * 0.05, 0.05);

    // ============================================
    // 4. FATOR: Queima (peso 10%)
    // ============================================
    // Baseline: 1M BRD queimado = neutro
    // Mais queima = preço sobe até 3%
    const burnFactor = Math.min((burnedAmount / 1000000) * 0.03, 0.03);

    // ============================================
    // SOMA DOS FATORES = bônus total
    // ============================================
    const totalBonus = txFactor + stakingFactor + walletFactor + burnFactor;

    // Preço alvo = base * (1 + bônus)
    const targetPrice = BASE_PRICE * (1 + totalBonus);

    // ============================================
    // SUAVIZAÇÃO (evita oscilações bruscas)
    // ============================================
    const newPrice = currentPrice + (targetPrice - currentPrice) * SMOOTHING;

    // ============================================
    // GARANTIR PISO ($10) E TETO ($50)
    // ============================================
    currentPrice = Math.max(BASE_PRICE, Math.min(newPrice, MAX_PRICE));

    // Arredonda para 2 casas
    currentPrice = Math.round(currentPrice * 100) / 100;

    // Registra histórico
    lastUpdate = Date.now();
    priceHistory.push({
        price: currentPrice,
        timestamp: lastUpdate,
        tx24h,
        staking: stakingAmount
    });

    // Mantém só as últimas 100
    if (priceHistory.length > 100) priceHistory.shift();

    return currentPrice;
}

/**
 * Aplica um "boost" manual (ex: quando alguém faz uma compra grande)
 * 
 * @param {number} amount - Valor em BRD da compra
 * @param {string} type - Tipo de operação ('buy', 'stake', 'transfer')
 */
function applyBoost(amount, type = 'buy') {
    if (!amount || amount <= 0) return currentPrice;

    let boost = 0;
    switch (type) {
        case 'buy':
            // Compras empurram o preço pra cima
            boost = Math.min(amount / 100000 * 0.01, 0.02);
            break;
        case 'stake':
            // Staking também ajuda
            boost = Math.min(amount / 100000 * 0.005, 0.01);
            break;
        case 'transfer':
            // Transferências ajudam menos
            boost = Math.min(amount / 100000 * 0.002, 0.005);
            break;
        default:
            boost = 0;
    }

    const newPrice = currentPrice * (1 + boost);
    currentPrice = Math.max(BASE_PRICE, Math.min(newPrice, MAX_PRICE));
    currentPrice = Math.round(currentPrice * 100) / 100;

    return currentPrice;
}

/**
 * Retorna o estado atual do preço
 */
function getPriceState() {
    return {
        basePrice: BASE_PRICE,
        currentPrice: currentPrice,
        maxPrice: MAX_PRICE,
        lastUpdate: lastUpdate,
        variation24h: currentPrice > BASE_PRICE
            ? ((currentPrice - BASE_PRICE) / BASE_PRICE * 100).toFixed(2)
            : '0.00',
        history: priceHistory.slice(-30)  // últimas 30
    };
}

/**
 * Retorna o preço atual
 */
function getCurrentPrice() {
    return currentPrice;
}

/**
 * Retorna preço base (piso)
 */
function getBasePrice() {
    return BASE_PRICE;
}

module.exports = {
    calculatePrice,
    applyBoost,
    getPriceState,
    getCurrentPrice,
    getBasePrice,
    BASE_PRICE,
    MAX_PRICE
};
