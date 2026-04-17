// analytics.js
// Blockchain Analytics Module for Bradicoin API

class BlockchainAnalytics {
    constructor(blockchain) {
        this.blockchain = blockchain;
        this.startTime = Date.now();
        this.metrics = {
            dailyTransactions: {},
            hourlyTransactions: {},
            blockTimeHistory: [],
            transactionValueHistory: [],
            addressActivity: {},
            popularContracts: {},
            gasPriceHistory: [],
            dailyActiveAddresses: {},
            weeklyVolume: {},
            transactionSizeHistory: []
        };
    }

    // Record a new transaction in metrics
    recordTransaction(transaction) {
        const date = new Date().toISOString().split('T')[0];
        const hour = new Date().getHours();
        const hourKey = `${date}-${hour}`;

        // Daily transaction count
        this.metrics.dailyTransactions[date] = (this.metrics.dailyTransactions[date] || 0) + 1;

        // Hourly transaction count
        this.metrics.hourlyTransactions[hourKey] = (this.metrics.hourlyTransactions[hourKey] || 0) + 1;

        // Track address activity (daily active addresses)
        if (!this.metrics.dailyActiveAddresses[date]) {
            this.metrics.dailyActiveAddresses[date] = new Set();
        }
        if (transaction.fromAddress && transaction.fromAddress !== 'system') {
            this.metrics.dailyActiveAddresses[date].add(transaction.fromAddress);
        }
        if (transaction.toAddress) {
            this.metrics.dailyActiveAddresses[date].add(transaction.toAddress);
        }

        // Track address totals
        this.updateAddressActivity(transaction.fromAddress, 'sent', transaction.amount);
        this.updateAddressActivity(transaction.toAddress, 'received', transaction.amount);

        // Track transaction value
        this.metrics.transactionValueHistory.push({
            amount: transaction.amount,
            timestamp: Date.now(),
            transactionId: transaction.id
        });

        // Keep only last 1000 transactions
        if (this.metrics.transactionValueHistory.length > 1000) {
            this.metrics.transactionValueHistory.shift();
        }

        // Track weekly volume
        const weekKey = this.getWeekKey(date);
        this.metrics.weeklyVolume[weekKey] = (this.metrics.weeklyVolume[weekKey] || 0) + transaction.amount;
    }

    // Record block mining time
    recordBlockTime(blockIndex, miningTimeMs) {
        this.metrics.blockTimeHistory.push({
            blockIndex: blockIndex,
            timestamp: Date.now(),
            timeMs: miningTimeMs
        });

        // Keep only last 100 blocks
        if (this.metrics.blockTimeHistory.length > 100) {
            this.metrics.blockTimeHistory.shift();
        }
    }

    // Record transaction size (number of inputs/outputs)
    recordTransactionSize(transactionId, size) {
        this.metrics.transactionSizeHistory.push({
            transactionId: transactionId,
            size: size,
            timestamp: Date.now()
        });

        if (this.metrics.transactionSizeHistory.length > 1000) {
            this.metrics.transactionSizeHistory.shift();
        }
    }

    // Record gas price for transaction
    recordGasPrice(gasPrice, transactionId) {
        this.metrics.gasPriceHistory.push({
            gasPrice: gasPrice,
            transactionId: transactionId,
            timestamp: Date.now()
        });

        if (this.metrics.gasPriceHistory.length > 1000) {
            this.metrics.gasPriceHistory.shift();
        }
    }

    // Update address activity tracking
    updateAddressActivity(address, type, amount) {
        if (!address || address === 'system') return;
        
        if (!this.metrics.addressActivity[address]) {
            this.metrics.addressActivity[address] = {
                sent: 0,
                received: 0,
                totalSent: 0,
                totalReceived: 0,
                lastActive: null,
                firstSeen: Date.now()
            };
        }

        if (type === 'sent') {
            this.metrics.addressActivity[address].sent++;
            this.metrics.addressActivity[address].totalSent += amount;
        } else {
            this.metrics.addressActivity[address].received++;
            this.metrics.addressActivity[address].totalReceived += amount;
        }
        
        this.metrics.addressActivity[address].lastActive = Date.now();
    }

    // Get week key from date
    getWeekKey(date) {
        const d = new Date(date);
        const year = d.getFullYear();
        const week = Math.ceil((((d - new Date(year, 0, 1)) / 86400000) + 1) / 7);
        return `${year}-W${week}`;
    }

    // Get general blockchain statistics
    getGeneralStats() {
        const chain = this.blockchain.chain || [];
        const totalTransactions = chain.reduce((sum, block) => sum + (block.transactions?.length || 0), 0);
        
        return {
            uptime: Date.now() - this.startTime,
            uptimeHuman: this.formatUptime(Date.now() - this.startTime),
            totalBlocks: chain.length,
            totalTransactions: totalTransactions,
            uniqueAddresses: Object.keys(this.metrics.addressActivity).length,
            averageBlockTime: this.getAverageBlockTime(),
            transactionsPerSecond: this.getTransactionsPerSecond(),
            networkHealth: this.checkNetworkHealth(),
            totalVolume: this.getTotalVolume(),
            averageTransactionValue: this.getAverageTransactionValue(),
            lastUpdated: new Date().toISOString()
        };
    }

    // Format uptime in human readable format
    formatUptime(ms) {
        const seconds = Math.floor(ms / 1000);
        const minutes = Math.floor(seconds / 60);
        const hours = Math.floor(minutes / 60);
        const days = Math.floor(hours / 24);
        
        if (days > 0) return `${days}d ${hours % 24}h`;
        if (hours > 0) return `${hours}h ${minutes % 60}m`;
        if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
        return `${seconds}s`;
    }

    // Get average block time
    getAverageBlockTime() {
        if (this.metrics.blockTimeHistory.length === 0) return 0;
        const sum = this.metrics.blockTimeHistory.reduce((acc, curr) => acc + curr.timeMs, 0);
        return Math.round(sum / this.metrics.blockTimeHistory.length);
    }

    // Get transactions per second
    getTransactionsPerSecond() {
        const uptimeSeconds = (Date.now() - this.startTime) / 1000;
        const totalTransactions = this.blockchain.chain?.reduce(
            (sum, block) => sum + (block.transactions?.length || 0), 0
        ) || 0;
        return uptimeSeconds > 0 ? totalTransactions / uptimeSeconds : 0;
    }

    // Check network health status
    checkNetworkHealth() {
        const chain = this.blockchain.chain || [];
        const isValid = this.blockchain.isChainValid ? this.blockchain.isChainValid() : true;
        const lastBlock = chain[chain.length - 1];
        const lastBlockTime = lastBlock?.timestamp || this.startTime;
        const timeSinceLastBlock = Date.now() - lastBlockTime;
        
        let status = 'healthy';
        let issues = [];
        
        if (!isValid) {
            status = 'critical';
            issues.push('Blockchain validation failed');
        }
        
        if (timeSinceLastBlock > 60000) { // more than 1 minute
            status = 'warning';
            issues.push('No new blocks for over 1 minute');
        }
        
        const pendingCount = this.blockchain.pendingTransactions?.length || 0;
        if (pendingCount > 100) {
            if (status === 'healthy') status = 'warning';
            issues.push(`High pending transactions: ${pendingCount}`);
        }
        
        return {
            status: status,
            isChainValid: isValid,
            timeSinceLastBlock: timeSinceLastBlock,
            pendingTransactions: pendingCount,
            issues: issues
        };
    }

    // Get total transaction volume
    getTotalVolume() {
        return this.metrics.transactionValueHistory.reduce((sum, tx) => sum + tx.amount, 0);
    }

    // Get average transaction value
    getAverageTransactionValue() {
        if (this.metrics.transactionValueHistory.length === 0) return 0;
        const sum = this.metrics.transactionValueHistory.reduce((acc, curr) => acc + curr.amount, 0);
        return sum / this.metrics.transactionValueHistory.length;
    }

    // Get top addresses by activity
    getTopAddresses(limit = 10, sortBy = 'total') {
        const sortFields = {
            'sent': (a, b) => b.sent - a.sent,
            'received': (a, b) => b.received - a.received,
            'total': (a, b) => (b.sent + b.received) - (a.sent + a.received),
            'volume': (a, b) => (b.totalSent + b.totalReceived) - (a.totalSent + a.totalReceived)
        };
        
        const sorter = sortFields[sortBy] || sortFields.total;
        
        return Object.entries(this.metrics.addressActivity)
            .map(([address, stats]) => ({
                address: address,
                sent: stats.sent,
                received: stats.received,
                totalTransactions: stats.sent + stats.received,
                totalSent: stats.totalSent,
                totalReceived: stats.totalReceived,
                totalVolume: stats.totalSent + stats.totalReceived,
                lastActive: new Date(stats.lastActive).toISOString(),
                firstSeen: new Date(stats.firstSeen).toISOString()
            }))
            .sort(sorter)
            .slice(0, limit);
    }

    // Get daily activity for last N days
    getDailyActivity(days = 7) {
        const result = [];
        const today = new Date();
        
        for (let i = days - 1; i >= 0; i--) {
            const date = new Date(today);
            date.setDate(today.getDate() - i);
            const dateStr = date.toISOString().split('T')[0];
            
            result.push({
                date: dateStr,
                transactions: this.metrics.dailyTransactions[dateStr] || 0,
                activeAddresses: this.metrics.dailyActiveAddresses[dateStr]?.size || 0
            });
        }
        
        return result;
    }

    // Get hourly activity for last 24 hours
    getHourlyActivity() {
        const result = [];
        const now = new Date();
        
        for (let i = 23; i >= 0; i--) {
            const hourDate = new Date(now);
            hourDate.setHours(now.getHours() - i);
            const hourKey = `${hourDate.toISOString().split('T')[0]}-${hourDate.getHours()}`;
            
            result.push({
                hour: hourDate.getHours(),
                date: hourDate.toISOString().split('T')[0],
                transactions: this.metrics.hourlyTransactions[hourKey] || 0
            });
        }
        
        return result;
    }

    // Get weekly volume data
    getWeeklyVolume(weeks = 8) {
        const weeks_data = [];
        const weekKeys = Object.keys(this.metrics.weeklyVolume).sort().reverse();
        
        for (let i = 0; i < Math.min(weeks, weekKeys.length); i++) {
            weeks_data.push({
                week: weekKeys[i],
                volume: this.metrics.weeklyVolume[weekKeys[i]]
            });
        }
        
        return weeks_data;
    }

    // Get block time history
    getBlockTimeHistory(limit = 20) {
        return this.metrics.blockTimeHistory.slice(-limit);
    }

    // Get transaction value distribution
    getTransactionValueDistribution() {
        const distribution = {
            '0-10': 0,
            '10-100': 0,
            '100-1000': 0,
            '1000-10000': 0,
            '10000+': 0
        };
        
        this.metrics.transactionValueHistory.forEach(tx => {
            const amount = tx.amount;
            if (amount < 10) distribution['0-10']++;
            else if (amount < 100) distribution['10-100']++;
            else if (amount < 1000) distribution['100-1000']++;
            else if (amount < 10000) distribution['1000-10000']++;
            else distribution['10000+']++;
        });
        
        return distribution;
    }

    // Get gas price statistics
    getGasPriceStats() {
        if (this.metrics.gasPriceHistory.length === 0) {
            return { average: 0, min: 0, max: 0, count: 0 };
        }
        
        const prices = this.metrics.gasPriceHistory.map(g => g.gasPrice);
        return {
            average: prices.reduce((a, b) => a + b, 0) / prices.length,
            min: Math.min(...prices),
            max: Math.max(...prices),
            count: prices.length,
            lastPrice: prices[prices.length - 1]
        };
    }

    // Get complete analytics report
    getFullReport() {
        return {
            generatedAt: new Date().toISOString(),
            general: this.getGeneralStats(),
            topAddresses: this.getTopAddresses(10),
            dailyActivity: this.getDailyActivity(7),
            hourlyActivity: this.getHourlyActivity(),
            weeklyVolume: this.getWeeklyVolume(8),
            blockTimeHistory: this.getBlockTimeHistory(20),
            transactionDistribution: this.getTransactionValueDistribution(),
            gasPriceStats: this.getGasPriceStats(),
            averageTransactionValue: this.getAverageTransactionValue(),
            totalVolume: this.getTotalVolume()
        };
    }

    // Export metrics to JSON
    exportMetrics() {
        return JSON.stringify(this.getFullReport(), null, 2);
    }

    // Export raw metrics data
    exportRawMetrics() {
        // Convert Sets to Arrays for JSON serialization
        const exportData = {
            ...this.metrics,
            dailyActiveAddresses: Object.fromEntries(
                Object.entries(this.metrics.dailyActiveAddresses).map(([key, value]) => [key, Array.from(value)])
            )
        };
        return JSON.stringify(exportData, null, 2);
    }

    // Reset all metrics
    resetMetrics() {
        this.startTime = Date.now();
        this.metrics = {
            dailyTransactions: {},
            hourlyTransactions: {},
            blockTimeHistory: [],
            transactionValueHistory: [],
            addressActivity: {},
            popularContracts: {},
            gasPriceHistory: [],
            dailyActiveAddresses: {},
            weeklyVolume: {},
            transactionSizeHistory: []
        };
        console.log('[Analytics] All metrics have been reset');
    }

    // Get simple dashboard data (lightweight)
    getDashboardData() {
        const chain = this.blockchain.chain || [];
        const lastBlock = chain[chain.length - 1];
        
        return {
            network: {
                height: chain.length,
                lastBlockHash: lastBlock?.hash || null,
                lastBlockTime: lastBlock?.timestamp ? new Date(lastBlock.timestamp).toISOString() : null,
                pendingTransactions: this.blockchain.pendingTransactions?.length || 0
            },
            transactions: {
                total: chain.reduce((sum, block) => sum + (block.transactions?.length || 0), 0),
                today: this.metrics.dailyTransactions[new Date().toISOString().split('T')[0]] || 0,
                averageValue: this.getAverageTransactionValue()
            },
            addresses: {
                total: Object.keys(this.metrics.addressActivity).length,
                activeToday: this.metrics.dailyActiveAddresses[new Date().toISOString().split('T')[0]]?.size || 0
            },
            performance: {
                averageBlockTimeMs: this.getAverageBlockTime(),
                transactionsPerSecond: this.getTransactionsPerSecond(),
                networkHealth: this.checkNetworkHealth().status
            }
        };
    }
}

module.exports = BlockchainAnalytics;
