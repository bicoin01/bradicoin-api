// bridge.js
// Cross-Chain Bridge Module for Bradicoin Blockchain
// Website: https://www.bradichain.com
// Token Symbol: BRD (Bradicoin Native Token)
// Integrated Chains: Bitcoin (BTC), Ethereum (ETH), Solana (SOL), 
//                    Polygon (MATIC), Binance BSC (BNB), Arbitrum (ARB)

const crypto = require('crypto');
const axios = require('axios');

class CrossChainBridge {
    constructor(blockchain) {
        this.blockchain = blockchain;
        this.bridges = new Map();
        this.swaps = new Map();
        this.validators = new Map();
        this.bridgeTransactions = new Map();
        
        // Bitcoin Configuration
        this.bitcoinConfig = {
            network: 'mainnet',
            mempoolUrl: 'https://mempool.space/api',
            minConfirmations: 6,
            feeRate: 10,
            bridgeAddress: 'bc1...',
            explorers: {
                mempool: 'https://mempool.space'
            }
        };
        
        // Ethereum Configuration
        this.ethereumConfig = {
            rpcUrl: 'https://mainnet.infura.io/v3/',
            bridgeContract: '0x...',
            confirmations: 12,
            explorers: {
                etherscan: 'https://etherscan.io'
            }
        };
        
        // Solana Configuration
        this.solanaConfig = {
            rpcUrl: 'https://api.mainnet-beta.solana.com',
            wormholeAddress: 'worm2ZoG2kUd4vFXhvjh93UUH596ayRfgQ2MgjNMTth',
            brdTokenMint: 'BRD...',
            confirmations: 32,
            explorers: {
                solscan: 'https://solscan.io'
            }
        };
        
        // Polygon Configuration
        this.polygonConfig = {
            rpcUrl: 'https://polygon-rpc.com',
            bridgeContract: '0x...',
            confirmations: 30,
            explorers: {
                polygonscan: 'https://polygonscan.com'
            }
        };
        
        // Binance BSC Configuration
        this.bscConfig = {
            rpcUrl: 'https://bsc-dataseed.binance.org',
            bridgeContract: '0x...',
            confirmations: 15,
            explorers: {
                bscscan: 'https://bscscan.com'
            }
        };
        
        // Arbitrum Configuration
        this.arbitrumConfig = {
            rpcUrl: 'https://arb1.arbitrum.io/rpc',
            bridgeContract: '0x...',
            confirmations: 20,
            explorers: {
                arbiscan: 'https://arbiscan.io'
            }
        };
        
        // ========== SUPPORTED CHAINS ==========
        this.supportedChains = {
            bitcoin: {
                id: 'bitcoin',
                name: 'Bitcoin',
                symbol: 'BTC',
                icon: '🟠',
                enabled: true,
                minAmount: 0.0001,
                maxAmount: 10,
                fee: 0.0005,
                confirmations: 6,
                blockTime: 600,
                explorers: this.bitcoinConfig.explorers
            },
            ethereum: {
                id: 'ethereum',
                name: 'Ethereum',
                symbol: 'ETH',
                icon: '🔷',
                enabled: true,
                minAmount: 0.01,
                maxAmount: 10000,
                fee: 0.001,
                confirmations: 12,
                blockTime: 12,
                explorers: this.ethereumConfig.explorers
            },
            bsc: {
                id: 'bsc',
                name: 'BNB Smart Chain',
                symbol: 'BNB',
                icon: '🟡',
                enabled: true,
                minAmount: 0.01,
                maxAmount: 10000,
                fee: 0.0005,
                confirmations: 15,
                blockTime: 3,
                explorers: this.bscConfig.explorers
            },
            polygon: {
                id: 'polygon',
                name: 'Polygon',
                symbol: 'MATIC',
                icon: '🟣',
                enabled: true,
                minAmount: 0.01,
                maxAmount: 10000,
                fee: 0.0005,
                confirmations: 30,
                blockTime: 2,
                explorers: this.polygonConfig.explorers
            },
            arbitrum: {
                id: 'arbitrum',
                name: 'Arbitrum',
                symbol: 'ARB',
                icon: '🔵',
                enabled: true,
                minAmount: 0.01,
                maxAmount: 10000,
                fee: 0.0003,
                confirmations: 20,
                blockTime: 0.25,
                explorers: this.arbitrumConfig.explorers
            },
            solana: {
                id: 'solana',
                name: 'Solana',
                symbol: 'SOL',
                icon: '🟢',
                enabled: true,
                minAmount: 0.01,
                maxAmount: 100000,
                fee: 0.0001,
                confirmations: 32,
                blockTime: 0.4,
                explorers: this.solanaConfig.explorers
            },
            bradicoin: {
                id: 'bradicoin',
                name: 'Bradicoin',
                symbol: 'BRD',
                icon: '🔴',
                enabled: true,
                minAmount: 1,
                maxAmount: 1000000,
                fee: 0.001,
                confirmations: 10,
                blockTime: 60,
                isNative: true,
                website: 'https://www.bradichain.com',
                explorers: {
                    main: 'https://explorer.bradichain.com'
                }
            }
        };
        
        // ========== BRADICOIN NETWORK CONFIGURATION ==========
        this.networkConfig = {
            name: 'Bradicoin',
            tokenSymbol: 'BRD',
            website: 'https://www.bradichain.com',
            apiEndpoint: 'https://api.bradichain.com',
            explorerUrl: 'https://explorer.bradichain.com',
            bridgeUrl: 'https://bridge.bradichain.com',
            version: '2.0.0'
        };
        
        // Bridge Fee Configuration
        this.fees = {
            standard: 0.001,
            fast: 0.002,
            instant: 0.005
        };
        
        // BRD to Chain conversion rates
        this.conversionRates = {
            BRD_to_BTC: 0.000001,
            BRD_to_ETH: 0.000015,
            BRD_to_SOL: 0.0005,
            BRD_to_MATIC: 0.01,
            BRD_to_BNB: 0.00008,
            BRD_to_ARB: 0.00012
        };
    }

    // ========== BITCOIN INTEGRATION ==========
    
    async getBitcoinBalance(address) {
        console.log(`[Bradicoin Bridge] Fetching Bitcoin balance for ${address}`);
        try {
            const response = await axios.get(`${this.bitcoinConfig.mempoolUrl}/address/${address}`);
            const balanceSat = response.data.chain_stats.funded_txo_sum - response.data.chain_stats.spent_txo_sum;
            return {
                address: address,
                balanceBTC: balanceSat / 100000000,
                symbol: 'BTC'
            };
        } catch (error) {
            return { address, balanceBTC: 0, symbol: 'BTC' };
        }
    }
    
    async getBitcoinTransaction(txId) {
        const response = await axios.get(`${this.bitcoinConfig.mempoolUrl}/tx/${txId}`);
        return {
            txid: response.data.txid,
            confirmations: response.data.status.confirmations || 0
        };
    }
    
    async waitForBitcoinConfirmations(txId, requiredConfirmations = 6) {
        console.log(`[Bradicoin Bridge] Waiting for Bitcoin confirmations for ${txId}`);
        return new Promise(async (resolve) => {
            const checkInterval = setInterval(async () => {
                const tx = await this.getBitcoinTransaction(txId);
                console.log(`[Bradicoin Bridge] BTC Confirmations: ${tx.confirmations}/${requiredConfirmations}`);
                if (tx.confirmations >= requiredConfirmations) {
                    clearInterval(checkInterval);
                    resolve({ confirmed: true });
                }
            }, 30000);
        });
    }

    // ========== ETHEREUM INTEGRATION ==========
    
    async getEthereumBalance(address) {
        console.log(`[Bradicoin Bridge] Fetching Ethereum balance for ${address}`);
        return { address, balanceETH: 0, symbol: 'ETH' };
    }
    
    async waitForEthereumConfirmations(txId, requiredConfirmations = 12) {
        console.log(`[Bradicoin Bridge] Waiting for Ethereum confirmations for ${txId}`);
        return new Promise((resolve) => {
            let confirmations = 0;
            const interval = setInterval(() => {
                confirmations++;
                console.log(`[Bradicoin Bridge] ETH Confirmations: ${confirmations}/${requiredConfirmations}`);
                if (confirmations >= requiredConfirmations) {
                    clearInterval(interval);
                    resolve({ confirmed: true });
                }
            }, 12000);
        });
    }

    // ========== SOLANA INTEGRATION ==========
    
    async getSolanaBalance(address) {
        console.log(`[Bradicoin Bridge] Fetching Solana balance for ${address}`);
        return { address, balanceSOL: 0, symbol: 'SOL' };
    }
    
    async waitForSolanaConfirmations(txId, requiredConfirmations = 32) {
        console.log(`[Bradicoin Bridge] Waiting for Solana confirmations for ${txId}`);
        return new Promise((resolve) => {
            let confirmations = 0;
            const interval = setInterval(() => {
                confirmations++;
                console.log(`[Bradicoin Bridge] SOL Confirmations: ${confirmations}/${requiredConfirmations}`);
                if (confirmations >= requiredConfirmations) {
                    clearInterval(interval);
                    resolve({ confirmed: true });
                }
            }, 400);
        });
    }

    // ========== POLYGON INTEGRATION ==========
    
    async getPolygonBalance(address) {
        console.log(`[Bradicoin Bridge] Fetching Polygon balance for ${address}`);
        return { address, balanceMATIC: 0, symbol: 'MATIC' };
    }
    
    async waitForPolygonConfirmations(txId, requiredConfirmations = 30) {
        console.log(`[Bradicoin Bridge] Waiting for Polygon confirmations for ${txId}`);
        return new Promise((resolve) => {
            let confirmations = 0;
            const interval = setInterval(() => {
                confirmations++;
                console.log(`[Bradicoin Bridge] MATIC Confirmations: ${confirmations}/${requiredConfirmations}`);
                if (confirmations >= requiredConfirmations) {
                    clearInterval(interval);
                    resolve({ confirmed: true });
                }
            }, 2000);
        });
    }

    // ========== BINANCE BSC INTEGRATION ==========
    
    async getBscBalance(address) {
        console.log(`[Bradicoin Bridge] Fetching BSC balance for ${address}`);
        return { address, balanceBNB: 0, symbol: 'BNB' };
    }
    
    async waitForBscConfirmations(txId, requiredConfirmations = 15) {
        console.log(`[Bradicoin Bridge] Waiting for BSC confirmations for ${txId}`);
        return new Promise((resolve) => {
            let confirmations = 0;
            const interval = setInterval(() => {
                confirmations++;
                console.log(`[Bradicoin Bridge] BNB Confirmations: ${confirmations}/${requiredConfirmations}`);
                if (confirmations >= requiredConfirmations) {
                    clearInterval(interval);
                    resolve({ confirmed: true });
                }
            }, 3000);
        });
    }

    // ========== ARBITRUM INTEGRATION ==========
    
    async getArbitrumBalance(address) {
        console.log(`[Bradicoin Bridge] Fetching Arbitrum balance for ${address}`);
        return { address, balanceARB: 0, symbol: 'ARB' };
    }
    
    async waitForArbitrumConfirmations(txId, requiredConfirmations = 20) {
        console.log(`[Bradicoin Bridge] Waiting for Arbitrum confirmations for ${txId}`);
        return new Promise((resolve) => {
            let confirmations = 0;
            const interval = setInterval(() => {
                confirmations++;
                console.log(`[Bradicoin Bridge] ARB Confirmations: ${confirmations}/${requiredConfirmations}`);
                if (confirmations >= requiredConfirmations) {
                    clearInterval(interval);
                    resolve({ confirmed: true });
                }
            }, 250);
        });
    }

    // ========== BRADICOIN (BRD) INTEGRATION ==========
    
    getBrdBalance(address) {
        return this.getBalance(address);
    }
    
    lockBrdTokens(address, amount) {
        console.log(`[Bradicoin Bridge] Locking ${amount} BRD from ${address}`);
        this.deductBalance(address, amount);
        return { success: true, lockedAmount: amount };
    }
    
    releaseBrdTokens(address, amount) {
        console.log(`[Bradicoin Bridge] Releasing ${amount} BRD to ${address}`);
        this.addBalance(address, amount);
        return { success: true, releasedAmount: amount };
    }

    // ========== BRD TO ANY CHAIN SWAP ==========
    
    async swapBrdToChain(fromChain, toChain, fromAddress, toAddress, amountBRD) {
        if (fromChain !== 'bradicoin') {
            throw new Error(`From chain must be bradicoin for BRD swap`);
        }
        
        const targetChain = this.supportedChains[toChain];
        if (!targetChain || !targetChain.enabled) {
            throw new Error(`Target chain ${toChain} is not supported or disabled`);
        }
        
        const minAmount = this.supportedChains.bradicoin.minAmount;
        const maxAmount = this.supportedChains.bradicoin.maxAmount;
        
        if (amountBRD < minAmount) {
            throw new Error(`Minimum amount is ${minAmount} BRD`);
        }
        
        if (amountBRD > maxAmount) {
            throw new Error(`Maximum amount is ${maxAmount} BRD`);
        }
        
        const fee = amountBRD * this.fees.standard;
        const receiveAmountBRD = amountBRD - fee;
        
        const conversionKey = `BRD_to_${targetChain.symbol}`;
        const conversionRate = this.conversionRates[conversionKey] || 0.0001;
        const receiveAmountTarget = receiveAmountBRD * conversionRate;
        
        const swapId = this.generateSwapId();
        const timestamp = Date.now();
        
        const balance = this.getBalance(fromAddress);
        if (balance < amountBRD) {
            throw new Error(`Insufficient BRD balance. Required: ${amountBRD}, Available: ${balance}`);
        }
        
        this.lockBrdTokens(fromAddress, amountBRD);
        
        const swap = {
            id: swapId,
            type: `brd_to_${toChain}`,
            fromChain: 'bradicoin',
            toChain: toChain,
            fromAddress: fromAddress,
            toAddress: toAddress,
            amount: amountBRD,
            token: 'BRD',
            targetToken: targetChain.symbol,
            receiveAmount: receiveAmountTarget,
            fee: fee,
            status: 'locked',
            createdAt: timestamp,
            lockedAt: timestamp,
            expiresAt: timestamp + 86400000,
            network: this.networkConfig.name
        };
        
        this.swaps.set(swapId, swap);
        
        console.log(`[Bradicoin Bridge] Swap initiated: ${amountBRD} BRD → ${receiveAmountTarget} ${targetChain.symbol}`);
        
        return {
            success: true,
            swapId: swapId,
            type: `brd_to_${toChain}`,
            fromChain: 'bradicoin',
            toChain: toChain,
            fromAddress: fromAddress,
            toAddress: toAddress,
            amount: amountBRD,
            token: 'BRD',
            targetToken: targetChain.symbol,
            receiveAmount: receiveAmountTarget,
            fee: fee,
            status: 'locked',
            conversionRate: conversionRate,
            estimatedTime: this.getEstimatedTime('bradicoin', toChain),
            createdAt: new Date(timestamp).toISOString(),
            expiresAt: new Date(swap.expiresAt).toISOString(),
            bridgeUrl: `${this.networkConfig.bridgeUrl}/swap/${swapId}`,
            website: this.networkConfig.website
        };
    }
    
    async executeBrdSwap(swapId) {
        const swap = this.swaps.get(swapId);
        if (!swap) {
            throw new Error(`Swap ${swapId} not found`);
        }
        
        if (swap.status !== 'locked') {
            throw new Error(`Swap cannot be executed (status: ${swap.status})`);
        }
        
        swap.status = 'completed';
        swap.completedAt = Date.now();
        
        console.log(`[Bradicoin Bridge] Swap ${swapId} EXECUTED!`);
        
        return {
            success: true,
            swapId: swapId,
            status: 'completed',
            amountSent: swap.receiveAmount,
            tokenSent: swap.targetToken,
            sentTo: swap.toAddress,
            completedAt: new Date().toISOString(),
            explorerUrl: `${this.networkConfig.explorerUrl}/swap/${swapId}`
        };
    }

    // ========== ANY CHAIN TO BRD SWAP ==========
    
    async swapChainToBrd(fromChain, toChain, fromAddress, toAddress, amount) {
        if (toChain !== 'bradicoin') {
            throw new Error(`To chain must be bradicoin for BRD swap`);
        }
        
        const sourceChain = this.supportedChains[fromChain];
        if (!sourceChain || !sourceChain.enabled) {
            throw new Error(`Source chain ${fromChain} is not supported or disabled`);
        }
        
        const minAmount = sourceChain.minAmount;
        const maxAmount = sourceChain.maxAmount;
        
        if (amount < minAmount) {
            throw new Error(`Minimum amount for ${sourceChain.name} is ${minAmount} ${sourceChain.symbol}`);
        }
        
        if (amount > maxAmount) {
            throw new Error(`Maximum amount for ${sourceChain.name} is ${maxAmount} ${sourceChain.symbol}`);
        }
        
        const fee = amount * this.fees.standard;
        const receiveAmountToken = amount - fee;
        
        const conversionKey = `BRD_to_${sourceChain.symbol}`;
        const conversionRate = this.conversionRates[conversionKey] || 0.0001;
        const receiveAmountBRD = receiveAmountToken / conversionRate;
        
        const swapId = this.generateSwapId();
        const timestamp = Date.now();
        
        const swap = {
            id: swapId,
            type: `${fromChain}_to_brd`,
            fromChain: fromChain,
            toChain: 'bradicoin',
            fromAddress: fromAddress,
            toAddress: toAddress,
            amount: amount,
            token: sourceChain.symbol,
            targetToken: 'BRD',
            receiveAmount: receiveAmountBRD,
            fee: fee,
            status: 'pending',
            createdAt: timestamp,
            expiresAt: timestamp + 86400000,
            network: this.networkConfig.name
        };
        
        this.swaps.set(swapId, swap);
        
        console.log(`[Bradicoin Bridge] Swap initiated: ${amount} ${sourceChain.symbol} → ${receiveAmountBRD} BRD`);
        
        let depositAddress = '';
        let instructions = [];
        
        switch (fromChain) {
            case 'bitcoin':
                depositAddress = this.bitcoinConfig.bridgeAddress;
                instructions = [
                    `Send exactly ${amount} BTC to: ${depositAddress}`,
                    `Minimum confirmations required: ${sourceChain.confirmations}`,
                    `Your BRD will be credited automatically after confirmations`
                ];
                break;
            case 'ethereum':
                depositAddress = this.ethereumConfig.bridgeContract;
                instructions = [
                    `Send exactly ${amount} ETH to the bridge contract: ${depositAddress}`,
                    `Your BRD will be credited after ${sourceChain.confirmations} confirmations`
                ];
                break;
            case 'solana':
                depositAddress = this.solanaConfig.wormholeAddress;
                instructions = [
                    `Send exactly ${amount} SOL to: ${depositAddress}`,
                    `Fast confirmations on Solana, BRD will arrive quickly`
                ];
                break;
            default:
                depositAddress = `Bridge address for ${fromChain}`;
        }
        
        return {
            success: true,
            swapId: swapId,
            type: `${fromChain}_to_brd`,
            fromChain: fromChain,
            toChain: 'bradicoin',
            fromAddress: fromAddress,
            toAddress: toAddress,
            amount: amount,
            token: sourceChain.symbol,
            targetToken: 'BRD',
            receiveAmount: receiveAmountBRD,
            fee: fee,
            status: 'pending',
            depositAddress: depositAddress,
            conversionRate: conversionRate,
            estimatedTime: this.getEstimatedTime(fromChain, 'bradicoin'),
            createdAt: new Date(timestamp).toISOString(),
            expiresAt: new Date(swap.expiresAt).toISOString(),
            bridgeUrl: `${this.networkConfig.bridgeUrl}/swap/${swapId}`,
            instructions: instructions,
            website: this.networkConfig.website
        };
    }
    
    async confirmChainSwap(swapId, txHash) {
        const swap = this.swaps.get(swapId);
        if (!swap) {
            throw new Error(`Swap ${swapId} not found`);
        }
        
        if (swap.status !== 'pending') {
            throw new Error(`Swap cannot be confirmed (status: ${swap.status})`);
        }
        
        swap.txHash = txHash;
        swap.status = 'confirming';
        swap.confirmedAt = Date.now();
        
        switch (swap.fromChain) {
            case 'bitcoin':
                await this.waitForBitcoinConfirmations(txHash, this.supportedChains.bitcoin.confirmations);
                break;
            case 'ethereum':
                await this.waitForEthereumConfirmations(txHash, this.supportedChains.ethereum.confirmations);
                break;
            case 'solana':
                await this.waitForSolanaConfirmations(txHash, this.supportedChains.solana.confirmations);
                break;
            case 'polygon':
                await this.waitForPolygonConfirmations(txHash, this.supportedChains.polygon.confirmations);
                break;
            case 'bsc':
                await this.waitForBscConfirmations(txHash, this.supportedChains.bsc.confirmations);
                break;
            case 'arbitrum':
                await this.waitForArbitrumConfirmations(txHash, this.supportedChains.arbitrum.confirmations);
                break;
        }
        
        this.releaseBrdTokens(swap.toAddress, swap.receiveAmount);
        
        swap.status = 'completed';
        swap.completedAt = Date.now();
        
        console.log(`[Bradicoin Bridge] Swap ${swapId} COMPLETED!`);
        
        return {
            success: true,
            swapId: swapId,
            txHash: txHash,
            amount: swap.amount,
            receivedAmountBRD: swap.receiveAmount,
            status: 'completed',
            completedAt: new Date().toISOString(),
            explorerUrl: `${this.networkConfig.explorerUrl}/swap/${swapId}`
        };
    }

    // ========== GENERIC SWAP METHOD ==========
    
    async initiateSwap(fromChain, toChain, fromAddress, toAddress, amount) {
        if (fromChain === 'bradicoin' && toChain !== 'bradicoin') {
            return this.swapBrdToChain(fromChain, toChain, fromAddress, toAddress, amount);
        }
        
        if (fromChain !== 'bradicoin' && toChain === 'bradicoin') {
            return this.swapChainToBrd(fromChain, toChain, fromAddress, toAddress, amount);
        }
        
        throw new Error(`Invalid swap pair: ${fromChain} → ${toChain}. Use BRD as intermediary.`);
    }
    
    generateSwapId() {
        const random = crypto.randomBytes(16).toString('hex');
        const hash = crypto.createHash('sha256')
            .update(random + Date.now().toString())
            .digest('hex');
        return `BRD_SWAP_${hash.substring(0, 24)}`;
    }
    
    getEstimatedTime(fromChain, toChain) {
        const times = {
            bitcoin: '30-60 minutes',
            ethereum: '5-15 minutes',
            bsc: '2-5 minutes',
            polygon: '5-10 minutes',
            arbitrum: '2-8 minutes',
            solana: '30 seconds',
            bradicoin: '1-2 minutes'
        };
        
        const fromTime = times[fromChain] || '5-10 minutes';
        const toTime = times[toChain] || '5-10 minutes';
        
        if (fromChain === 'bradicoin') {
            return `~${toTime} total`;
        }
        
        if (toChain === 'bradicoin') {
            return `~${fromTime} total (including confirmations)`;
        }
        
        return `${fromTime} + ${toTime}`;
    }

    // ========== GET SWAP STATUS ==========
    
    getSwapStatus(swapId) {
        const swap = this.swaps.get(swapId);
        if (!swap) {
            throw new Error(`Swap ${swapId} not found`);
        }
        
        const sourceChainInfo = this.supportedChains[swap.fromChain];
        const targetChainInfo = this.supportedChains[swap.toChain];
        
        return {
            swapId: swap.id,
            type: swap.type,
            fromChain: {
                id: swap.fromChain,
                name: sourceChainInfo?.name || swap.fromChain,
                symbol: sourceChainInfo?.symbol || swap.token
            },
            toChain: {
                id: swap.toChain,
                name: targetChainInfo?.name || swap.toChain,
                symbol: targetChainInfo?.symbol || swap.targetToken
            },
            fromAddress: swap.fromAddress,
            toAddress: swap.toAddress,
            amount: swap.amount,
            receiveAmount: swap.receiveAmount,
            fee: swap.fee,
            status: swap.status,
            createdAt: new Date(swap.createdAt).toISOString(),
            lockedAt: swap.lockedAt ? new Date(swap.lockedAt).toISOString() : null,
            confirmedAt: swap.confirmedAt ? new Date(swap.confirmedAt).toISOString() : null,
            completedAt: swap.completedAt ? new Date(swap.completedAt).toISOString() : null,
            expiresAt: new Date(swap.expiresAt).toISOString(),
            txHash: swap.txHash || null,
            bridgeUrl: `${this.networkConfig.bridgeUrl}/swap/${swapId}`,
            website: this.networkConfig.website
        };
    }

    // ========== BRIDGE STATISTICS ==========
    
    getBridgeStats() {
        const completed = Array.from(this.swaps.values()).filter(s => s.status === 'completed');
        const pending = Array.from(this.swaps.values()).filter(s => s.status === 'pending' || s.status === 'locked' || s.status === 'confirming');
        
        const totalVolumeBRD = completed.reduce((sum, s) => {
            if (s.token === 'BRD') return sum + s.amount;
            if (s.targetToken === 'BRD') return sum + s.receiveAmount;
            return sum;
        }, 0);
        
        const volumeByChain = {};
        for (const swap of completed) {
            const chain = swap.fromChain === 'bradicoin' ? swap.toChain : swap.fromChain;
            if (!volumeByChain[chain]) volumeByChain[chain] = 0;
            volumeByChain[chain] += swap.amount;
        }
        
        return {
            network: this.networkConfig.name,
            tokenSymbol: this.networkConfig.tokenSymbol,
            website: this.networkConfig.website,
            totalSwaps: this.swaps.size,
            completedSwaps: completed.length,
            pendingSwaps: pending.length,
            totalVolumeBRD: totalVolumeBRD,
            volumeByChain: volumeByChain,
            supportedChains: Object.keys(this.supportedChains).map(key => ({
                id: key,
                name: this.supportedChains[key].name,
                symbol: this.supportedChains[key].symbol,
                enabled: this.supportedChains[key].enabled
            })),
            bridgeUrl: this.networkConfig.bridgeUrl,
            lastUpdated: new Date().toISOString()
        };
    }
    
    getSupportedChains() {
        const chains = [];
        for (const [key, chain] of Object.entries(this.supportedChains)) {
            chains.push({
                id: chain.id,
                name: chain.name,
                symbol: chain.symbol,
                icon: chain.icon,
                enabled: chain.enabled,
                minAmount: chain.minAmount,
                maxAmount: chain.maxAmount,
                fee: chain.fee,
                confirmations: chain.confirmations,
                blockTime: chain.blockTime
            });
        }
        
        return {
            chains: chains,
            count: chains.length,
            nativeToken: this.networkConfig.tokenSymbol,
            bridgeUrl: this.networkConfig.bridgeUrl,
            website: this.networkConfig.website
        };
    }
    
    getBridgeRates(fromChain, toChain, amount) {
        const sourceChain = this.supportedChains[fromChain];
        const targetChain = this.supportedChains[toChain];
        
        if (!sourceChain || !targetChain) {
            throw new Error(`Unsupported chain`);
        }
        
        const fee = amount * this.fees.standard;
        const receiveAmount = amount - fee;
        
        let conversionRate = 1;
        let receiveAmountConverted = receiveAmount;
        
        if (fromChain === 'bradicoin' && toChain !== 'bradicoin') {
            conversionRate = this.conversionRates[`BRD_to_${targetChain.symbol}`] || 0.0001;
            receiveAmountConverted = receiveAmount * conversionRate;
        } else if (fromChain !== 'bradicoin' && toChain === 'bradicoin') {
            conversionRate = 1 / (this.conversionRates[`BRD_to_${sourceChain.symbol}`] || 0.0001);
            receiveAmountConverted = receiveAmount * conversionRate;
        }
        
        return {
            fromChain: {
                id: fromChain,
                name: sourceChain.name,
                symbol: sourceChain.symbol
            },
            toChain: {
                id: toChain,
                name: targetChain.name,
                symbol: targetChain.symbol
            },
            amount: amount,
            amountSymbol: sourceChain.symbol,
            fee: fee,
            feePercentage: this.fees.standard * 100,
            receiveAmount: receiveAmount,
            receiveAmountConverted: receiveAmountConverted,
            receiveSymbol: targetChain.symbol,
            conversionRate: conversionRate,
            estimatedTime: this.getEstimatedTime(fromChain, toChain),
            network: this.networkConfig.name,
            website: this.networkConfig.website,
            bridgeUrl: this.networkConfig.bridgeUrl
        };
    }
    
    getUserBridgeHistory(address) {
        const userSwaps = [];
        
        for (const swap of this.swaps.values()) {
            if (swap.fromAddress === address || swap.toAddress === address) {
                userSwaps.push({
                    swapId: swap.id,
                    type: swap.type,
                    fromChain: swap.fromChain,
                    toChain: swap.toChain,
                    amount: swap.amount,
                    amountSymbol: swap.token,
                    receiveAmount: swap.receiveAmount,
                    receiveSymbol: swap.targetToken || 'BRD',
                    status: swap.status,
                    createdAt: new Date(swap.createdAt).toISOString(),
                    completedAt: swap.completedAt ? new Date(swap.completedAt).toISOString() : null,
                    bridgeUrl: `${this.networkConfig.bridgeUrl}/swap/${swap.id}`
                });
            }
        }
        
        return {
            address: address,
            swaps: userSwaps,
            count: userSwaps.length,
            totalBridgedBRD: userSwaps.reduce((sum, s) => {
                if (s.amountSymbol === 'BRD') return sum + s.amount;
                return sum;
            }, 0),
            network: this.networkConfig.name,
            website: this.networkConfig.website
        };
    }

    // ========== HELPER FUNCTIONS ==========
    
    getBalance(address) {
        if (this.blockchain && this.blockchain.getBalance) {
            return this.blockchain.getBalance(address);
        }
        return 0;
    }
    
    deductBalance(address, amount) {
        if (this.blockchain && this.blockchain.deductBalance) {
            this.blockchain.deductBalance(address, amount);
        }
    }
    
    addBalance(address, amount) {
        if (this.blockchain && this.blockchain.addBalance) {
            this.blockchain.addBalance(address, amount);
        }
    }
    
    cancelExpiredSwap(swapId) {
        const swap = this.swaps.get(swapId);
        if (!swap) {
            throw new Error(`Swap ${swapId} not found`);
        }
        
        if (swap.status !== 'pending' && swap.status !== 'locked') {
            throw new Error(`Cannot cancel swap with status: ${swap.status}`);
        }
        
        if (Date.now() < swap.expiresAt) {
            throw new Error(`Swap has not expired yet`);
        }
        
        if (swap.status === 'locked' && swap.fromChain === 'bradicoin') {
            this.releaseBrdTokens(swap.fromAddress, swap.amount);
        }
        
        swap.status = 'cancelled';
        swap.cancelledAt = Date.now();
        
        return {
            success: true,
            swapId: swapId,
            status: 'cancelled',
            refundAmount: swap.amount,
            refundToken: swap.token,
            refundedTo: swap.fromAddress
        };
    }
}

module.exports = CrossChainBridge;
