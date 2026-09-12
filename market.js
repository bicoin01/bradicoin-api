// market.js
// ============================================
// Bradicoin Blockchain - Market API
// ============================================

const blockchain = require('./blockchain');

// ============================================
// TOKENOMICS
// ============================================
const tokenomics = {
    name: 'Bradicoin',
    symbol: 'BRD',
    priceUSD: 10.00,                    // $10/BRD
    priceEUR: 9.20,                     // ~$10 em Euro
    priceGBP: 7.90,                     // ~$10 em Libra
    priceJPY: 1500,                     // ~$10 em Iene
    marketCap: 790000000000000,         // $790 trilhões USD
    maxSupply: 79000000000000,          // 79 trilhões de BRD
    circulatingSupply: 79000000000000,  // 79 trilhões
    totalSupply: 79000000000000,        // 79 trilhões
    volume24h: 50000000000,             // $50 bilhões volume diário
    ath: 15.50,                         // All Time High $15.50
    athDate: '2026-01-15',
    atl: 0.01,                          // All Time Low $0.01
    atlDate: '2024-03-20'
};

// ============================================
// HISTÓRICO DE PREÇOS (cache em memória)
// ============================================
const priceHistory = [];

function initPriceHistory() {
    const now = new Date();
    for (let i = 30; i >= 0; i--) {
        const date = new Date(now);
        date.setDate(date.getDate() - i);

        const variation = (Math.random() - 0.5) * 2;
        const price = tokenomics.priceUSD + variation;

        priceHistory.push({
            date: date.toISOString().split('T')[0],
            price: parseFloat(price.toFixed(2)),
            volume: tokenomics.volume24h * (0.5 + Math.random())
        });
    }
}

// ============================================
// INICIALIZAR
// ============================================
async function initialize() {
    if (priceHistory.length === 0) {
        initPriceHistory();
    }
    console.log('✅ Market inicializado');
    console.log(`📊 Market Cap: $${formatNumber(tokenomics.marketCap)}`);
    console.log(`💎 Supply: ${formatNumber(tokenomics.maxSupply)} BRD`);
    console.log(`💰 Preço: $${tokenomics.priceUSD}/BRD`);
}

// ============================================
// HELPERS
// ============================================
function formatNumber(num) {
    if (num >= 1e12) return (num / 1e12).toFixed(2) + 'T';
    if (num >= 1e9) return (num / 1e9).toFixed(2) + 'B';
    if (num >= 1e6) return (num / 1e6).toFixed(2) + 'M';
    return num.toLocaleString();
}

function safeChain() {
    return Array.isArray(blockchain.chain) ? blockchain.chain : [];
}

// ============================================
// PREÇO ATUAL
// ============================================
function getPrice(currency = 'USD') {
    const prices = {
        USD: tokenomics.priceUSD,
        EUR: tokenomics.priceEUR,
        GBP: tokenomics.priceGBP,
        JPY: tokenomics.priceJPY,
        BTC: tokenomics.priceUSD / 60000,
        ETH: tokenomics.priceUSD / 3000,
        BNB: tokenomics.priceUSD / 350,
        SOL: tokenomics.priceUSD / 100
    };

    const requested = String(currency).toUpperCase();

    return {
        success: true,
        currency: requested,
        price: prices[requested] || prices.USD,
        symbol: tokenomics.symbol,
        name: tokenomics.name,
        marketCap: tokenomics.marketCap,
        timestamp: new Date().toISOString()
    };
}

// ============================================
// TODOS OS PREÇOS
// ============================================
function getAllPrices() {
    return {
        success: true,
        symbol: tokenomics.symbol,
        name: tokenomics.name,
        prices: {
            USD: tokenomics.priceUSD,
            EUR: tokenomics.priceEUR,
            GBP: tokenomics.priceGBP,
            JPY: tokenomics.priceJPY,
            BTC: tokenomics.priceUSD / 60000,
            ETH: tokenomics.priceUSD / 3000,
            BNB: tokenomics.priceUSD / 350,
            SOL: tokenomics.priceUSD / 100,
            XRP: tokenomics.priceUSD / 2.5,
            DOGE: tokenomics.priceUSD / 0.15,
            ADA: tokenomics.priceUSD / 0.45,
            DOT: tokenomics.priceUSD / 8
        },
        lastUpdated: new Date().toISOString()
    };
}

// ============================================
// CIRCULATING SUPPLY
// ============================================
function getCirculatingSupply() {
    let circulating = 0;

    for (const block of safeChain()) {
        if (!Array.isArray(block.transactions)) continue;

        for (const tx of block.transactions) {
            if (tx.fromAddress === null && tx.toAddress) {
                circulating += tx.amount || 0;
            }
        }
    }

    // Se a chain está vazia, usa o valor da tokenomics
    return circulating > 0 ? circulating : tokenomics.circulatingSupply;
}

function getTotalSupply() {
    return tokenomics.totalSupply;
}

function getMaxSupply() {
    return tokenomics.maxSupply;
}

// ============================================
// MARKET CAP
// ============================================
function getMarketCap() {
    const circulatingSupply = getCirculatingSupply();
    const totalSupply = getTotalSupply();
    const price = tokenomics.priceUSD;

    // Usa o marketCap da tokenomics (se definido), senão calcula
    const marketCapUSD = tokenomics.marketCap || circulatingSupply * price;

    return {
        success: true,
        symbol: tokenomics.symbol,
        name: tokenomics.name,
        marketCapUSD,
        marketCapFormatted: formatNumber(marketCapUSD),
        marketCapRank: 1,
        fullyDilutedMarketCap: totalSupply * price,
        fullyDilutedMarketCapFormatted: formatNumber(totalSupply * price),
        circulatingSupply,
        circulatingSupplyFormatted: formatNumber(circulatingSupply),
        totalSupply,
        totalSupplyFormatted: formatNumber(totalSupply),
        maxSupply: tokenomics.maxSupply,
        maxSupplyFormatted: formatNumber(tokenomics.maxSupply),
        percentOfMaxSupply: ((circulatingSupply / tokenomics.maxSupply) * 100).toFixed(2)
    };
}

// ============================================
// VOLUME 24H
// ============================================
function getVolume() {
    let volume24hBRD = 0;
    const oneDayAgo = new Date();
    oneDayAgo.setDate(oneDayAgo.getDate() - 1);

    for (const block of safeChain()) {
        const blockDate = new Date(block.timestamp);
        if (blockDate <= oneDayAgo) continue;
        if (!Array.isArray(block.transactions)) continue;

        for (const tx of block.transactions) {
            if (tx.amount && tx.fromAddress !== null) {
                volume24hBRD += tx.amount;
            }
        }
    }

    const volumeUSD = volume24hBRD > 0
        ? volume24hBRD * tokenomics.priceUSD
        : tokenomics.volume24h;

    return {
        success: true,
        symbol: tokenomics.symbol,
        volume24hBRD,
        volume24hBRDFormatted: formatNumber(volume24hBRD),
        volume24hUSD: volumeUSD,
        volume24hUSDFormatted: formatNumber(volumeUSD),
        volume24hEUR: volumeUSD * 0.92,
        volume24hGBP: volumeUSD * 0.79,
        percentChange: calculateVolumeChange(),
        timestamp: new Date().toISOString()
    };
}

function calculateVolumeChange() {
    const change = (Math.random() - 0.5) * 30;
    return parseFloat(change.toFixed(2));
}

// ============================================
// VARIAÇÃO DE PREÇO
// ============================================
function calculatePriceChange(amount, unit) {
    const currentPrice = tokenomics.priceUSD;

    const now = new Date();
    const pastDate = new Date(now);
    if (unit === 'hour') pastDate.setHours(pastDate.getHours() - amount);
    else pastDate.setDate(pastDate.getDate() - amount);

    const pastDateStr = pastDate.toISOString().split('T')[0];
    const historical = priceHistory.find((h) => h.date === pastDateStr);

    let historicalPrice;
    if (historical) {
        historicalPrice = historical.price;
    } else {
        const daysBack = unit === 'hour' ? amount / 24 : amount;
        historicalPrice = currentPrice * (1 - daysBack * 0.001);
    }

    const change = currentPrice - historicalPrice;
    const percentChange = (change / historicalPrice) * 100;

    return {
        price: currentPrice,
        priceFormatted: `$${currentPrice.toFixed(2)}`,
        historicalPrice: parseFloat(historicalPrice.toFixed(2)),
        historicalPriceFormatted: `$${historicalPrice.toFixed(2)}`,
        change: parseFloat(change.toFixed(2)),
        changeFormatted: `${change >= 0 ? '+' : ''}$${change.toFixed(2)}`,
        percentChange: parseFloat(percentChange.toFixed(2)),
        percentChangeFormatted: `${percentChange >= 0 ? '+' : ''}${percentChange.toFixed(2)}%`,
        direction: percentChange >= 0 ? 'up' : 'down'
    };
}

function getPriceChange() {
    return {
        success: true,
        symbol: tokenomics.symbol,
        name: tokenomics.name,
        currentPrice: tokenomics.priceUSD,
        currentPriceFormatted: `$${tokenomics.priceUSD.toFixed(2)}`,
        changes: {
            '1h': calculatePriceChange(1, 'hour'),
            '24h': calculatePriceChange(24, 'hour'),
            '7d': calculatePriceChange(7, 'day'),
            '30d': calculatePriceChange(30, 'day'),
            '90d': calculatePriceChange(90, 'day'),
            '1y': calculatePriceChange(365, 'day')
        },
        ath: tokenomics.ath,
        athFormatted: `$${tokenomics.ath.toFixed(2)}`,
        athDate: tokenomics.athDate,
        atl: tokenomics.atl,
        atlFormatted: `$${tokenomics.atl.toFixed(2)}`,
        atlDate: tokenomics.atlDate
    };
}

// ============================================
// HISTÓRICO
// ============================================
function getPriceHistory(days = 30, interval = 'day') {
    let history = [];

    if (interval === 'hour') {
        for (let i = 24; i >= 0; i--) {
            const date = new Date();
            date.setHours(date.getHours() - i);
            const variation = (Math.random() - 0.5) * 1;
            const price = tokenomics.priceUSD + variation;
            history.push({
                timestamp: date.toISOString(),
                price: parseFloat(price.toFixed(2)),
                volume: tokenomics.volume24h * (0.3 + Math.random() * 0.7)
            });
        }
    } else {
        history = priceHistory.slice(-days).map((h) => ({
            date: h.date,
            price: h.price,
            volume: h.volume
        }));
    }

    return {
        success: true,
        symbol: tokenomics.symbol,
        days,
        interval,
        history,
        startDate: history[0]?.date || history[0]?.timestamp,
        endDate: history[history.length - 1]?.date || history[history.length - 1]?.timestamp
    };
}

// ============================================
// ESTATÍSTICAS GERAIS
// ============================================
function getMarketStats() {
    const priceChange24h = calculatePriceChange(24, 'hour');
    const volume = getVolume();

    return {
        success: true,
        symbol: tokenomics.symbol,
        name: tokenomics.name,
        rank: 1,
        priceUSD: tokenomics.priceUSD,
        priceChange24h: priceChange24h.percentChange,
        marketCapUSD: tokenomics.marketCap,
        marketCapFormatted: formatNumber(tokenomics.marketCap),
        volume24hUSD: volume.volume24hUSD,
        volume24hUSDFormatted: formatNumber(volume.volume24hUSD),
        circulatingSupply: getCirculatingSupply(),
        totalSupply: tokenomics.totalSupply,
        maxSupply: tokenomics.maxSupply,
        ath: tokenomics.ath,
        athDate: tokenomics.athDate,
        atl: tokenomics.atl,
        atlDate: tokenomics.atlDate,
        lastUpdated: new Date().toISOString()
    };
}

function getTokenomics() {
    return {
        success: true,
        name: tokenomics.name,
        symbol: tokenomics.symbol,
        priceUSD: tokenomics.priceUSD,
        marketCapUSD: tokenomics.marketCap,
        marketCapFormatted: formatNumber(tokenomics.marketCap),
        maxSupply: tokenomics.maxSupply,
        maxSupplyFormatted: formatNumber(tokenomics.maxSupply),
        circulatingSupply: getCirculatingSupply(),
        totalSupply: tokenomics.totalSupply,
        volume24h: tokenomics.volume24h,
        volume24hFormatted: formatNumber(tokenomics.volume24h),
        ath: tokenomics.ath,
        athDate: tokenomics.athDate,
        atl: tokenomics.atl,
        atlDate: tokenomics.atlDate,
        supplyDistribution: {
            staking: '15%',
            miningRewards: '40%',
            ecosystem: '20%',
            team: '10%',
            community: '10%',
            reserve: '5%'
        }
    };
}

// ============================================
// ATUALIZAR PREÇO (admin)
// ============================================
function updatePrice(newPriceUSD) {
    if (newPriceUSD <= 0) {
        throw new Error('Preço deve ser maior que 0');
    }

    const oldPrice = tokenomics.priceUSD;
    tokenomics.priceUSD = newPriceUSD;
    tokenomics.priceEUR = newPriceUSD * 0.92;
    tokenomics.priceGBP = newPriceUSD * 0.79;
    tokenomics.priceJPY = newPriceUSD * 150;

    // Recalcula market cap com novo preço
    tokenomics.marketCap = tokenomics.circulatingSupply * newPriceUSD;

    return {
        success: true,
        oldPrice,
        newPrice: newPriceUSD,
        newMarketCap: tokenomics.marketCap,
        message: `Preço atualizado de $${oldPrice} para $${newPriceUSD}`
    };
}

// ============================================
// SIMPLE PRICE (CoinGecko-style)
// ============================================
function getSimplePrice() {
    return {
        brd: {
            usd: tokenomics.priceUSD,
            usd_market_cap: tokenomics.marketCap,
            usd_24h_vol: getVolume().volume24hUSD,
            usd_24h_change: calculatePriceChange(24, 'hour').percentChange,
            last_updated_at: Math.floor(Date.now() / 1000)
        }
    };
}

// ============================================
// EXPORTA (funções, não classe)
// ============================================
module.exports = {
    initialize,              // ✅ server.js precisa
    getPrice,                // ✅ server.js precisa
    getAllPrices,
    getMarketCap,
    getCirculatingSupply,
    getTotalSupply,
    getMaxSupply,
    getVolume,
    getPriceChange,
    getPriceHistory,
    getMarketStats,
    getTokenomics,
    updatePrice,
    getSimplePrice
};
