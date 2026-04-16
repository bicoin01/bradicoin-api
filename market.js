const crypto = require('crypto');

class MarketAPI {
    constructor(blockchain, walletManager) {
        this.blockchain = blockchain;
        this.walletManager = walletManager;
        
        // Bradicoin Tokenomics
        this.tokenomics = {
            name: 'Bradicoin',
            symbol: 'BRD',
            priceUSD: 10.00,              // $10 USD per BRD
            priceEUR: 9.20,               // ~$10 USD in Euro
            priceGBP: 7.90,               // ~$10 USD in Pound
            priceJPY: 1500,               // ~$10 USD in Yen
            marketCap: 790000000000000,   // $790 Trillion USD
            maxSupply: 79000000000000,    // 79 Trillion BRD
            circulatingSupply: 79000000000000,
            totalSupply: 79000000000000,
            volume24h: 50000000000,       // $50 Billion daily volume
            ath: 15.50,                   // All Time High $15.50
            athDate: '2026-01-15',
            atl: 0.01,                   // All Time Low $0.01
            atlDate: '2024-03-20'
        };
        
        // Price history cache
        this.priceHistory = [];
        this.initPriceHistory();
    }
    
    // Initialize price history (last 30 days)
    initPriceHistory() {
        const now = new Date();
        for (let i = 30; i >= 0; i--) {
            const date = new Date(now);
            date.setDate(date.getDate() - i);
            
            // Add some random variation for historical data
            const variation = (Math.random() - 0.5) * 2;
            const price = this.tokenomics.priceUSD + variation;
            
            this.priceHistory.push({
                date: date.toISOString().split('T')[0],
                price: parseFloat(price.toFixed(2)),
                volume: this.tokenomics.volume24h * (0.5 + Math.random())
            });
        }
    }
    
    // Get current price
    getPrice(currency = 'USD') {
        const prices = {
            USD: this.tokenomics.priceUSD,
            EUR: this.tokenomics.priceEUR,
            GBP: this.tokenomics.priceGBP,
            JPY: this.tokenomics.priceJPY,
            BTC: this.tokenomics.priceUSD / 60000,
            ETH: this.tokenomics.priceUSD / 3000,
            BNB: this.tokenomics.priceUSD / 350,
            SOL: this.tokenomics.priceUSD / 100
        };
        
        const requestedCurrency = currency.toUpperCase();
        
        return {
            success: true,
            currency: requestedCurrency,
            price: prices[requestedCurrency] || prices.USD,
            symbol: this.tokenomics.symbol,
            name: this.tokenomics.name,
            timestamp: new Date().toISOString()
        };
    }
    
    // Get all prices in different currencies
    getAllPrices() {
        return {
            success: true,
            symbol: this.tokenomics.symbol,
            name: this.tokenomics.name,
            prices: {
                USD: this.tokenomics.priceUSD,
                EUR: this.tokenomics.priceEUR,
                GBP: this.tokenomics.priceGBP,
                JPY: this.tokenomics.priceJPY,
                BTC: this.tokenomics.priceUSD / 60000,
                ETH: this.tokenomics.priceUSD / 3000,
                BNB: this.tokenomics.priceUSD / 350,
                SOL: this.tokenomics.priceUSD / 100,
                XRP: this.tokenomics.priceUSD / 2.5,
                DOGE: this.tokenomics.priceUSD / 0.15,
                ADA: this.tokenomics.priceUSD / 0.45,
                DOT: this.tokenomics.priceUSD / 8
            },
            lastUpdated: new Date().toISOString()
        };
    }
    
    // Get market cap information
    getMarketCap() {
        const circulatingSupply = this.getCirculatingSupply();
        const totalSupply = this.getTotalSupply();
        const price = this.tokenomics.priceUSD;
        
        return {
            success: true,
            symbol: this.tokenomics.symbol,
            name: this.tokenomics.name,
            marketCapUSD: this.tokenomics.marketCap,
            marketCapFormatted: this.formatNumber(this.tokenomics.marketCap),
            marketCapRank: 1,
            fullyDilutedMarketCap: totalSupply * price,
            circulatingSupply: circulatingSupply,
            circulatingSupplyFormatted: this.formatNumber(circulatingSupply),
            totalSupply: totalSupply,
            totalSupplyFormatted: this.formatNumber(totalSupply),
            maxSupply: this.tokenomics.maxSupply,
            maxSupplyFormatted: this.formatNumber(this.tokenomics.maxSupply),
            percentOfMaxSupply: ((circulatingSupply / this.tokenomics.maxSupply) * 100).toFixed(2)
        };
    }
    
    // Get circulating supply (actual coins in circulation)
    getCirculatingSupply() {
        let circulating = 0;
        
        // Calculate from blockchain
        for (const block of this.blockchain.chain) {
            if (block.transactions && Array.isArray(block.transactions)) {
                for (const tx of block.transactions) {
                    // Count mining rewards (new coins created)
                    if (tx.fromAddress === null && tx.toAddress) {
                        circulating += tx.amount || 0;
                    }
                }
            }
        }
        
        // If blockchain is empty, use default value
        if (circulating === 0) {
            circulating = this.tokenomics.circulatingSupply;
        }
        
        return circulating;
    }
    
    // Get total supply
    getTotalSupply() {
        return this.tokenomics.totalSupply;
    }
    
    // Get max supply (hard cap)
    getMaxSupply() {
        return this.tokenomics.maxSupply;
    }
    
    // Get volume information
    getVolume() {
        // Calculate real volume from last 24h of transactions
        let volume24hBRD = 0;
        const oneDayAgo = new Date();
        oneDayAgo.setDate(oneDayAgo.getDate() - 1);
        
        for (const block of this.blockchain.chain) {
            const blockDate = new Date(block.timestamp);
            if (blockDate > oneDayAgo) {
                if (block.transactions && Array.isArray(block.transactions)) {
                    for (const tx of block.transactions) {
                        if (tx.amount && tx.fromAddress !== null) {
                            volume24hBRD += tx.amount;
                        }
                    }
                }
            }
        }
        
        // Convert to USD
        const volumeUSD = volume24hBRD * this.tokenomics.priceUSD;
        
        return {
            success: true,
            symbol: this.tokenomics.symbol,
            volume24hBRD: volume24hBRD,
            volume24hBRDFormatted: this.formatNumber(volume24hBRD),
            volume24hUSD: volumeUSD || this.tokenomics.volume24h,
            volume24hUSDFormatted: this.formatNumber(volumeUSD || this.tokenomics.volume24h),
            volume24hEUR: (volumeUSD || this.tokenomics.volume24h) * 0.92,
            volume24hGBP: (volumeUSD || this.tokenomics.volume24h) * 0.79,
            percentChange: this.calculateVolumeChange(),
            timestamp: new Date().toISOString()
        };
    }
    
    // Calculate volume change from previous day
    calculateVolumeChange() {
        // Simulate small variation between -15% and +15%
        const change = (Math.random() - 0.5) * 30;
        return parseFloat(change.toFixed(2));
    }
    
    // Get price change statistics
    getPriceChange() {
        const changes = {
            '1h': this.calculatePriceChange(1, 'hour'),
            '24h': this.calculatePriceChange(24, 'hour'),
            '7d': this.calculatePriceChange(7, 'day'),
            '30d': this.calculatePriceChange(30, 'day'),
            '90d': this.calculatePriceChange(90, 'day'),
            '1y': this.calculatePriceChange(365, 'day')
        };
        
        return {
            success: true,
            symbol: this.tokenomics.symbol,
            name: this.tokenomics.name,
            currentPrice: this.tokenomics.priceUSD,
            currentPriceFormatted: `$${this.tokenomics.priceUSD.toFixed(2)}`,
            changes: changes,
            ath: this.tokenomics.ath,
            athFormatted: `$${this.tokenomics.ath.toFixed(2)}`,
            athDate: this.tokenomics.athDate,
            atl: this.tokenomics.atl,
            atlFormatted: `$${this.tokenomics.atl.toFixed(2)}`,
            atlDate: this.tokenomics.atlDate
        };
    }
    
    // Calculate price change over period
    calculatePriceChange(amount, unit) {
        const currentPrice = this.tokenomics.priceUSD;
        
        // Get historical price from priceHistory
        let historicalPrice = this.tokenomics.priceUSD;
        const now = new Date();
        const pastDate = new Date(now);
        
        if (unit === 'hour') {
            pastDate.setHours(pastDate.getHours() - amount);
        } else {
            pastDate.setDate(pastDate.getDate() - amount);
        }
        
        // Find price from that date in history
        const pastDateStr = pastDate.toISOString().split('T')[0];
        const historical = this.priceHistory.find(h => h.date === pastDateStr);
        
        if (historical) {
            historicalPrice = historical.price;
        } else {
            // Simulate historical price based on days back
            const daysBack = unit === 'hour' ? amount / 24 : amount;
            historicalPrice = currentPrice * (1 - (daysBack * 0.001));
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
    
    // Get price history for chart
    getPriceHistory(days = 30, interval = 'day') {
        let history = [];
        
        if (interval === 'hour') {
            // Last 24 hours
            for (let i = 24; i >= 0; i--) {
                const date = new Date();
                date.setHours(date.getHours() - i);
                const variation = (Math.random() - 0.5) * 1;
                const price = this.tokenomics.priceUSD + variation;
                history.push({
                    timestamp: date.toISOString(),
                    price: parseFloat(price.toFixed(2)),
                    volume: this.tokenomics.volume24h * (0.3 + Math.random() * 0.7)
                });
            }
        } else {
            // Daily history
            const limitedHistory = this.priceHistory.slice(-days);
            history = limitedHistory.map(h => ({
                date: h.date,
                price: h.price,
                volume: h.volume
            }));
        }
        
        return {
            success: true,
            symbol: this.tokenomics.symbol,
            days: days,
            interval: interval,
            history: history,
            startDate: history[0]?.date || history[0]?.timestamp,
            endDate: history[history.length - 1]?.date || history[history.length - 1]?.timestamp
        };
    }
    
    // Get market statistics overview
    getMarketStats() {
        const priceChange24h = this.calculatePriceChange(24, 'hour');
        const volume = this.getVolume();
        const marketCap = this.getMarketCap();
        
        return {
            success: true,
            symbol: this.tokenomics.symbol,
            name: this.tokenomics.name,
            rank: 1,
            priceUSD: this.tokenomics.priceUSD,
            priceChange24h: priceChange24h.percentChange,
            marketCapUSD: this.tokenomics.marketCap,
            volume24hUSD: volume.volume24hUSD,
            circulatingSupply: this.getCirculatingSupply(),
            totalSupply: this.tokenomics.totalSupply,
            maxSupply: this.tokenomics.maxSupply,
            ath: this.tokenomics.ath,
            athDate: this.tokenomics.athDate,
            atl: this.tokenomics.atl,
            atlDate: this.tokenomics.atlDate,
            lastUpdated: new Date().toISOString()
        };
    }
    
    // Get tokenomics information
    getTokenomics() {
        return {
            success: true,
            name: this.tokenomics.name,
            symbol: this.tokenomics.symbol,
            priceUSD: this.tokenomics.priceUSD,
            marketCapUSD: this.tokenomics.marketCap,
            maxSupply: this.tokenomics.maxSupply,
            circulatingSupply: this.getCirculatingSupply(),
            totalSupply: this.tokenomics.totalSupply,
            volume24h: this.tokenomics.volume24h,
            ath: this.tokenomics.ath,
            athDate: this.tokenomics.athDate,
            atl: this.tokenomics.atl,
            atlDate: this.tokenomics.atlDate,
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
    
    // Format large numbers
    formatNumber(num) {
        if (num >= 1e12) {
            return (num / 1e12).toFixed(2) + 'T';
        }
        if (num >= 1e9) {
            return (num / 1e9).toFixed(2) + 'B';
        }
        if (num >= 1e6) {
            return (num / 1e6).toFixed(2) + 'M';
        }
        return num.toLocaleString();
    }
    
    // Update price (admin function)
    updatePrice(newPriceUSD) {
        if (newPriceUSD <= 0) {
            throw new Error('Price must be greater than 0');
        }
        
        const oldPrice = this.tokenomics.priceUSD;
        this.tokenomics.priceUSD = newPriceUSD;
        this.tokenomics.priceEUR = newPriceUSD * 0.92;
        this.tokenomics.priceGBP = newPriceUSD * 0.79;
        this.tokenomics.priceJPY = newPriceUSD * 150;
        this.tokenomics.marketCap = this.tokenomics.circulatingSupply * newPriceUSD;
        
        return {
            success: true,
            oldPrice: oldPrice,
            newPrice: newPriceUSD,
            message: `Price updated from $${oldPrice} to $${newPriceUSD}`
        };
    }
    
    // Get simple price (lightweight)
    getSimplePrice() {
        return {
            brd: {
                usd: this.tokenomics.priceUSD,
                usd_market_cap: this.tokenomics.marketCap,
                usd_24h_vol: this.tokenomics.volume24h,
                usd_24h_change: this.calculatePriceChange(24, 'hour').percentChange,
                last_updated_at: Math.floor(Date.now() / 1000)
            }
        };
    }
}

module.exports = MarketAPI;
