// atomic-swap/chains/evmAdapter.js
// ============================================
// EVM Adapter REAL — HTLC em Ethereum + L2s + sidechains
// ============================================
// Suporta: Ethereum, BSC, Polygon, Avalanche, Arbitrum, Optimism, Base
// ============================================

const { ethers } = require('ethers');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const BaseAdapter = require('./baseAdapter');

// Carrega ABI uma vez
let HTLC_ABI;
try {
    HTLC_ABI = require('../contracts/evmHTLC.abi.json');
} catch (_) {
    console.warn('⚠️  evmHTLC.abi.json não encontrado');
    HTLC_ABI = [];
}

// ============================================
// CONFIG POR CHAIN EVM
// ============================================
const EVM_CHAINS = {
    ethereum: {
        name: 'Ethereum', symbol: 'ETH',
        chainId: 1,
        testnetChainId: 11155111,   // Sepolia
        confirmations: 12,
        blockTime: 12,
        envKey: 'ETHEREUM',
        explorer: {
            mainnet: 'https://etherscan.io',
            sepolia: 'https://sepolia.etherscan.io'
        }
    },
    bsc: {
        name: 'BNB Smart Chain', symbol: 'BNB',
        chainId: 56,
        testnetChainId: 97,         // BSC Testnet
        confirmations: 15,
        blockTime: 3,
        envKey: 'BSC',
        explorer: {
            mainnet: 'https://bscscan.com',
            testnet: 'https://testnet.bscscan.com'
        }
    },
    polygon: {
        name: 'Polygon', symbol: 'POL',
        chainId: 137,
        testnetChainId: 80002,      // Amoy
        confirmations: 30,
        blockTime: 2,
        envKey: 'POLYGON',
        explorer: {
            mainnet: 'https://polygonscan.com',
            amoy: 'https://amoy.polygonscan.com'
        }
    },
    avalanche: {
        name: 'Avalanche', symbol: 'AVAX',
        chainId: 43114,
        testnetChainId: 43113,      // Fuji
        confirmations: 12,
        blockTime: 2,
        envKey: 'AVALANCHE',
        explorer: {
            mainnet: 'https://snowtrace.io',
            fuji: 'https://testnet.snowtrace.io'
        }
    },
    arbitrum: {
        name: 'Arbitrum One', symbol: 'ETH',
        chainId: 42161,
        testnetChainId: 421614,     // Arbitrum Sepolia
        confirmations: 20,
        blockTime: 0.25,
        envKey: 'ARBITRUM',
        explorer: {
            mainnet: 'https://arbiscan.io',
            sepolia: 'https://sepolia.arbiscan.io'
        }
    },
    optimism: {
        name: 'Optimism', symbol: 'ETH',
        chainId: 10,
        testnetChainId: 11155420,   // OP Sepolia
        confirmations: 20,
        blockTime: 2,
        envKey: 'OPTIMISM',
        explorer: {
            mainnet: 'https://optimistic.etherscan.io',
            sepolia: 'https://sepolia-optimism.etherscan.io'
        }
    },
    base: {
        name: 'Base', symbol: 'ETH',
        chainId: 8453,
        testnetChainId: 84532,      // Base Sepolia
        confirmations: 20,
        blockTime: 2,
        envKey: 'BASE',
        explorer: {
            mainnet: 'https://basescan.org',
            sepolia: 'https://sepolia.basescan.org'
        }
    }
};

// ============================================
// ADAPTER
// ============================================
class EvmAdapter extends BaseAdapter {
    constructor(chainKey) {
        const cfg = EVM_CHAINS[chainKey];
        if (!cfg) throw new Error(`Chain EVM ${chainKey} não suportada`);

        const networkName = process.env[`${cfg.envKey}_NETWORK`] || 'sepolia';
        const isTestnet = networkName !== 'mainnet';

        super({
            name: cfg.name,
            symbol: cfg.symbol,
            confirmations: parseInt(process.env[`${cfg.envKey}_MIN_CONFIRMATIONS`]) || cfg.confirmations,
            blockTime: cfg.blockTime,
            enabled: true
        });

        this.chainKey = chainKey;
        this.cfg = cfg;
        this.networkName = networkName;
        this.chainId = isTestnet ? cfg.testnetChainId : cfg.chainId;
        this.isTestnet = isTestnet;
        this.explorer = cfg.explorer[networkName] || cfg.explorer.mainnet;

        // Provider
        const rpcUrl = process.env[`${cfg.envKey}_RPC_URL`];
        if (!rpcUrl) {
            console.warn(`⚠️  ${this.name}: RPC_URL não configurada`);
            this.provider = null;
        } else {
            this.provider = new ethers.JsonRpcProvider(rpcUrl, {
                chainId: this.chainId,
                name: networkName
            });
        }

        // Signer
        const pk = process.env[`${cfg.envKey}_PRIVATE_KEY`];
        if (pk && this.provider) {
            try {
                const key = pk.startsWith('0x') ? pk : `0x${pk}`;
                this.wallet = new ethers.Wallet(key, this.provider);
            } catch (e) {
                console.error(`❌ ${this.name}: private key inválida`);
                this.wallet = null;
            }
        } else {
            this.wallet = null;
        }

        // Contrato HTLC
        const contractAddr = process.env[`${cfg.envKey}_HTLC_CONTRACT`];
        if (contractAddr && this.provider) {
            this.htlcContract = new ethers.Contract(contractAddr, HTLC_ABI, this.provider);

            // Se tem wallet, conecta signer
            if (this.wallet) {
                this.htlcContractWithSigner = this.htlcContract.connect(this.wallet);
            }
        } else {
            this.htlcContract = null;
            this.htlcContractWithSigner = null;
        }
    }

    // ============================================
    // HELPERS
    // ============================================
    _requireContract() {
        if (!this.htlcContract || !this.htlcContractWithSigner) {
            throw new Error(
                `${this.name}: contrato HTLC não configurado. ` +
                `Rode: node scripts/deploy-evm-htlc.js ${this.chainKey}`
            );
        }
    }

    _requireWallet() {
        if (!this.wallet) {
            throw new Error(`${this.name}: PRIVATE_KEY não configurada`);
        }
    }

    _getGasPrice() {
        const gwei = parseFloat(process.env[`${this.cfg.envKey}_DEFAULT_GAS_PRICE_GWEI`]) || 2;
        return ethers.parseUnits(gwei.toString(), 'gwei');
    }

    /**
     * Converte hashlock hex (string) → bytes32
     */
    _hashlockToBytes32(hashlock) {
        if (!/^[a-fA-F0-9]{64}$/.test(hashlock)) {
            throw new Error('hashlock deve ser 32 bytes em hex');
        }
        return '0x' + hashlock;
    }

    /**
     * Converte preimage hex → bytes32
     */
    _preimageToBytes32(preimage) {
        const clean = preimage.startsWith('0x') ? preimage.slice(2) : preimage;
        if (clean.length !== 64) {
            throw new Error('preimage deve ter 32 bytes');
        }
        return '0x' + clean;
    }

    /**
     * Converte swapId (string arbitrário) → bytes32
     */
    _swapIdToBytes32(swapId) {
        return ethers.keccak256(ethers.toUtf8Bytes(swapId));
    }

    // ============================================
    // LOCK HTLC — Native (ETH/BNB/POL/AVAX)
    // ============================================
    async lockHtlc({ sender, receiver, amount, hashlock, timelock, swapId, token = null }) {
        this._requireContract();
        this._requireWallet();

        const senderAddr = this.wallet.address;
        const bytes32SwapId = this._swapIdToBytes32(swapId || crypto.randomUUID());
        const bytes32Hashlock = this._hashlockToBytes32(hashlock);
        const receiverAddr = ethers.getAddress(receiver);

        // Verifica timelock
        const now = Math.floor(Date.now() / 1000);
        if (timelock <= now + 1800) {
            throw new Error('timelock muito curto (min 30 min)');
        }
        if (timelock > now + 7 * 86400) {
            throw new Error('timelock muito longo (max 7 dias)');
        }

        let tx;

        if (!token || token === ethers.ZeroAddress) {
            // LOCK NATIVE
            const value = ethers.parseEther(amount.toString());

            tx = await this.htlcContractWithSigner.lockNative(
                bytes32SwapId,
                receiverAddr,
                bytes32Hashlock,
                timelock,
                { value, gasPrice: this._getGasPrice() }
            );
        } else {
            // LOCK ERC20
            const tokenAddr = ethers.getAddress(token);
            const tokenContract = new ethers.Contract(
                tokenAddr,
                ['function decimals() view returns (uint8)'],
                this.provider
            );
            const decimals = await tokenContract.decimals();
            const amountUnits = ethers.parseUnits(amount.toString(), decimals);

            // Aprova o contrato HTLC (se necessário)
            const erc20 = new ethers.Contract(
                tokenAddr,
                [
                    'function allowance(address,address) view returns (uint256)',
                    'function approve(address,uint256) returns (bool)'
                ],
                this.wallet
            );

            const allowance = await erc20.allowance(senderAddr, await this.htlcContract.getAddress());
            if (allowance < amountUnits) {
                console.log(`🔓 Aprovando ${this.symbol} ERC20...`);
                const approveTx = await erc20.approve(
                    await this.htlcContract.getAddress(),
                    ethers.MaxUint256
                );
                await approveTx.wait();
            }

            tx = await this.htlcContractWithSigner.lockERC20(
                bytes32SwapId,
                tokenAddr,
                amountUnits,
                receiverAddr,
                bytes32Hashlock,
                timelock,
                { gasPrice: this._getGasPrice() }
            );
        }

        console.log(`📡 ${this.name} lock tx: ${tx.hash}`);
        const receipt = await tx.wait();

        if (receipt.status !== 1) {
            throw new Error('Transação falhou on-chain');
        }

        const htlcId = `evm_${this.chainKey}_${tx.hash}`;

        return {
            htlcId,
            txHash: tx.hash,
            swapId: bytes32SwapId,
            chain: this.chainKey,
            hashlock,
            timelock,
            blockNumber: receipt.blockNumber,
            explorerUrl: `${this.explorer}/tx/${tx.hash}`
        };
    }

    // ============================================
    // CLAIM HTLC
    // ============================================
    async claimHtlc({ htlcId, preimage, claimer, swapId = null }) {
        this._requireContract();
        this._requireWallet();

        // Precisa do swapId on-chain (bytes32)
        let bytes32SwapId;
        if (swapId) {
            bytes32SwapId = swapId.startsWith('0x') ? swapId : this._swapIdToBytes32(swapId);
        } else {
            // Deriva do htlcId se for padrão `evm_<chain>_<txhash>`
            const parts = htlcId.split('_');
            if (parts.length >= 3 && parts[0] === 'evm') {
                const txHash = parts.slice(2).join('_');
                // ⚠️ Não dá pra derivar swapId do txHash sem ler evento
                throw new Error('swapId obrigatório pra claim (não dá pra derivar do txHash)');
            }
            throw new Error('swapId obrigatório');
        }

        const bytes32Preimage = this._preimageToBytes32(preimage);

        const tx = await this.htlcContractWithSigner.claim(bytes32SwapId, bytes32Preimage, {
            gasPrice: this._getGasPrice()
        });

        console.log(`📡 ${this.name} claim tx: ${tx.hash}`);
        const receipt = await tx.wait();

        if (receipt.status !== 1) {
            throw new Error('Claim falhou on-chain');
        }

        return {
            txHash: tx.hash,
            preimage,
            blockNumber: receipt.blockNumber,
            explorerUrl: `${this.explorer}/tx/${tx.hash}`
        };
    }

    // ============================================
    // REFUND HTLC
    // ============================================
    async refundHtlc({ htlcId, refunder, swapId = null }) {
        this._requireContract();
        this._requireWallet();

        let bytes32SwapId;
        if (swapId) {
            bytes32SwapId = swapId.startsWith('0x') ? swapId : this._swapIdToBytes32(swapId);
        } else {
            throw new Error('swapId obrigatório pra refund');
        }

        const tx = await this.htlcContractWithSigner.refund(bytes32SwapId, {
            gasPrice: this._getGasPrice()
        });

        console.log(`📡 ${this.name} refund tx: ${tx.hash}`);
        const receipt = await tx.wait();

        if (receipt.status !== 1) {
            throw new Error('Refund falhou on-chain');
        }

        return {
            txHash: tx.hash,
            blockNumber: receipt.blockNumber,
            explorerUrl: `${this.explorer}/tx/${tx.hash}`
        };
    }

    // ============================================
    // STATUS HTLC
    // ============================================
    async getHtlcStatus(htlcIdOrSwapId) {
        this._requireContract();

        const bytes32SwapId = htlcIdOrSwapId.startsWith('0x') && htlcIdOrSwapId.length === 66
            ? htlcIdOrSwapId
            : this._swapIdToBytes32(htlcIdOrSwapId);

        const swap = await this.htlcContract.getSwap(bytes32SwapId);

        if (swap.sender === ethers.ZeroAddress) {
            throw new Error('HTLC não encontrado on-chain');
        }

        let status = 'locked';
        if (swap.claimed) status = 'claimed';
        else if (swap.refunded) status = 'refunded';
        else if (Math.floor(Date.now() / 1000) >= Number(swap.timelock)) status = 'expired';

        return {
            swapId: bytes32SwapId,
            sender: swap.sender,
            receiver: swap.receiver,
            token: swap.token,
            amount: ethers.formatEther(swap.amount),
            hashlock: swap.hashlock,
            timelock: Number(swap.timelock
