// smartcontracts.js
// Smart Contracts & Tokens Module for Bradichain Blockchain
// Website: https://www.bradichain.com

const crypto = require('crypto');

class SmartContractEngine {
    constructor(blockchain) {
        this.blockchain = blockchain;
        this.contracts = new Map(); // Store deployed contracts
        this.tokens = new Map(); // Store token definitions (ERC-20 like)
        this.contractExecutions = new Map(); // Store execution history
        this.gasPrices = {
            standard: 1,
            fast: 2,
            instant: 5
        };
        
        // Bradichain network configuration
        this.networkConfig = {
            name: 'Bradichain',
            website: 'https://www.bradichain.com',
            apiEndpoint: 'https://api.bradichain.com',
            explorerUrl: 'https://explorer.bradichain.com',
            docsUrl: 'https://docs.bradichain.com',
            version: '2.0.0',
            chainId: 'bradichain-mainnet-1'
        };
    }

    // ========== 1. DEPLOY SMART CONTRACT ==========
    
    deployContract(contractCode, owner, constructorArgs = []) {
        const contractId = this.generateContractId();
        const timestamp = Date.now();
        
        // Validate contract code
        if (!this.validateContractCode(contractCode)) {
            throw new Error('Invalid contract code');
        }
        
        // Calculate deployment cost (gas)
        const gasUsed = this.calculateGasUsage(contractCode);
        const deploymentCost = gasUsed * this.gasPrices.standard;
        
        // Check if owner has enough balance
        const ownerBalance = this.getBalance(owner);
        if (ownerBalance < deploymentCost) {
            throw new Error(`Insufficient balance. Required: ${deploymentCost} BRAD`);
        }
        
        // Create contract instance
        const contract = {
            id: contractId,
            code: contractCode,
            owner: owner,
            createdAt: timestamp,
            status: 'active',
            transactions: 0,
            balance: 0,
            gasUsed: gasUsed,
            abi: this.extractABI(contractCode),
            storage: new Map(),
            events: [],
            constructor: constructorArgs
        };
        
        // Execute constructor if exists
        if (constructorArgs.length > 0) {
            const result = this.executeConstructor(contract, constructorArgs);
            if (!result.success) {
                throw new Error(`Constructor failed: ${result.error}`);
            }
        }
        
        // Store contract
        this.contracts.set(contractId, contract);
        
        // Deduct deployment cost
        this.deductBalance(owner, deploymentCost);
        
        console.log(`[Bradichain SmartContract] Contract deployed: ${contractId} by ${owner}`);
        console.log(`[Bradichain SmartContract] View on explorer: ${this.networkConfig.explorerUrl}/contract/${contractId}`);
        
        return {
            contractId: contractId,
            owner: owner,
            gasUsed: gasUsed,
            cost: deploymentCost,
            timestamp: timestamp,
            network: this.networkConfig.name,
            website: this.networkConfig.website,
            explorerUrl: `${this.networkConfig.explorerUrl}/contract/${contractId}`
        };
    }
    
    generateContractId() {
        const timestamp = Date.now().toString();
        const random = crypto.randomBytes(16).toString('hex');
        const hash = crypto.createHash('sha256')
            .update(timestamp + random + this.networkConfig.chainId)
            .digest('hex');
        return `0x${hash.substring(0, 40)}`;
    }
    
    validateContractCode(code) {
        // Basic validation - check for required structure
        try {
            // Check if code has basic contract structure
            const hasFunctions = code.includes('function') || code.includes('=>');
            const hasReturn = code.includes('return');
            return hasFunctions && hasReturn;
        } catch (error) {
            return false;
        }
    }
    
    calculateGasUsage(code) {
        // Calculate gas based on code complexity
        const lines = code.split('\n').length;
        const functions = (code.match(/function/g) || []).length;
        const operations = (code.match(/[+\-*/%=<>!&|]/g) || []).length;
        
        return (lines * 10) + (functions * 50) + (operations * 5);
    }
    
    extractABI(code) {
        // Extract function signatures from contract code
        const functions = [];
        const functionRegex = /function\s+(\w+)\s*\(([^)]*)\)/g;
        let match;
        
        while ((match = functionRegex.exec(code)) !== null) {
            functions.push({
                name: match[1],
                params: match[2].split(',').filter(p => p.trim()),
                signature: `${match[1]}(${match[2]})`
            });
        }
        
        return functions;
    }
    
    executeConstructor(contract, args) {
        try {
            // Simulate constructor execution
            contract.constructorExecuted = true;
            contract.constructorArgs = args;
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }
    
    // ========== 2. EXECUTE SMART CONTRACT FUNCTION ==========
    
    async executeContract(contractId, functionName, params, caller, value = 0) {
        const contract = this.contracts.get(contractId);
        if (!contract) {
            throw new Error(`Contract ${contractId} not found on Bradichain`);
        }
        
        if (contract.status !== 'active') {
            throw new Error(`Contract ${contractId} is not active`);
        }
        
        // Find function in ABI
        const func = contract.abi.find(f => f.name === functionName);
        if (!func) {
            throw new Error(`Function ${functionName} not found in contract`);
        }
        
        // Calculate gas for execution
        const gasUsed = this.calculateExecutionGas(functionName, params);
        const executionCost = gasUsed * this.gasPrices.standard;
        
        // Check caller balance
        const callerBalance = this.getBalance(caller);
        if (callerBalance < executionCost + value) {
            throw new Error(`Insufficient balance. Required: ${executionCost + value} BRAD`);
        }
        
        // Execute function
        const executionId = crypto.randomBytes(16).toString('hex');
        const startTime = Date.now();
        
        let result;
        try {
            result = this.runContractFunction(contract, functionName, params, caller, value);
        } catch (error) {
            throw new Error(`Contract execution failed: ${error.message}`);
        }
        
        const executionTime = Date.now() - startTime;
        
        // Deduct gas fee
        this.deductBalance(caller, executionCost);
        
        // Update contract balance if value was sent
        if (value > 0) {
            contract.balance += value;
            this.deductBalance(caller, value);
        }
        
        // Record execution
        const execution = {
            id: executionId,
            contractId: contractId,
            function: functionName,
            params: params,
            caller: caller,
            value: value,
            result: result,
            gasUsed: gasUsed,
            executionTime: executionTime,
            timestamp: Date.now(),
            network: this.networkConfig.name
        };
        
        this.contractExecutions.set(executionId, execution);
        contract.transactions++;
        
        console.log(`[Bradichain SmartContract] Contract ${contractId} function ${functionName} executed by ${caller}`);
        console.log(`[Bradichain SmartContract] Execution ID: ${executionId}`);
        
        return {
            executionId: executionId,
            result: result,
            gasUsed: gasUsed,
            executionTime: executionTime,
            network: this.networkConfig.name,
            website: this.networkConfig.website,
            explorerUrl: `${this.networkConfig.explorerUrl}/tx/${executionId}`
        };
    }
    
    calculateExecutionGas(functionName, params) {
        const baseGas = 100;
        const paramsGas = params.length * 20;
        return baseGas + paramsGas;
    }
    
    runContractFunction(contract, functionName, params, caller, value) {
        // This is a simplified execution engine
        // In production, you would use a proper VM (like V8 isolated)
        
        const storage = contract.storage;
        
        // Pre-defined function handlers for common operations
        const handlers = {
            'transfer': (params) => {
                const [to, amount] = params;
                if (value && value < amount) {
                    throw new Error('Insufficient value sent');
                }
                return { 
                    success: true, 
                    from: caller, 
                    to: to, 
                    amount: amount,
                    explorerUrl: `${this.networkConfig.explorerUrl}/transfer/${Date.now()}`
                };
            },
            
            'balanceOf': (params) => {
                const [address] = params;
                const balance = this.getBalance(address);
                return { 
                    address: address, 
                    balance: balance,
                    network: this.networkConfig.name
                };
            },
            
            'set': (params) => {
                const [key, value] = params;
                storage.set(key, value);
                return { success: true, key: key, value: value };
            },
            
            'get': (params) => {
                const [key] = params;
                const value = storage.get(key);
                return { key: key, value: value };
            },
            
            'deposit': () => {
                if (!value || value <= 0) {
                    throw new Error('Deposit amount required');
                }
                contract.balance += value;
                return { 
                    success: true, 
                    deposited: value, 
                    newBalance: contract.balance,
                    message: `Deposited ${value} BRAD to contract`
                };
            },
            
            'withdraw': (params) => {
                const [amount] = params;
                if (amount > contract.balance) {
                    throw new Error('Insufficient contract balance');
                }
                contract.balance -= amount;
                this.addBalance(caller, amount);
                return { 
                    success: true, 
                    withdrawn: amount, 
                    newBalance: contract.balance,
                    message: `Withdrawn ${amount} BRAD from contract`
                };
            },
            
            'getContractInfo': () => {
                return {
                    id: contract.id,
                    owner: contract.owner,
                    balance: contract.balance,
                    transactions: contract.transactions,
                    status: contract.status,
                    network: this.networkConfig.name,
                    website: this.networkConfig.website
                };
            }
        };
        
        if (handlers[functionName]) {
            return handlers[functionName](params);
        }
        
        // Generic execution for custom functions
        return {
            success: true,
            function: functionName,
            params: params,
            caller: caller,
            value: value,
            network: this.networkConfig.name,
            storageSnapshot: Array.from(storage.entries())
        };
    }
    
    // ========== 3. CREATE TOKEN (ERC-20 LIKE) ==========
    
    createToken(tokenName, symbol, totalSupply, decimals = 18, owner) {
        const tokenId = this.generateTokenId();
        const timestamp = Date.now();
        
        // Check if token name or symbol already exists
        for (const token of this.tokens.values()) {
            if (token.symbol === symbol) {
                throw new Error(`Token symbol ${symbol} already exists on Bradichain`);
            }
        }
        
        const token = {
            id: tokenId,
            name: tokenName,
            symbol: symbol,
            totalSupply: totalSupply,
            decimals: decimals,
            owner: owner,
            createdAt: timestamp,
            balances: new Map(),
            allowances: new Map(),
            transactions: 0,
            holders: 0,
            network: this.networkConfig.name
        };
        
        // Assign all tokens to owner
        token.balances.set(owner, totalSupply);
        token.holders = 1;
        
        this.tokens.set(tokenId, token);
        
        console.log(`[Bradichain Token] Token created: ${tokenName} (${symbol}) - Total Supply: ${totalSupply}`);
        console.log(`[Bradichain Token] View on explorer: ${this.networkConfig.explorerUrl}/token/${tokenId}`);
        
        return {
            tokenId: tokenId,
            name: tokenName,
            symbol: symbol,
            totalSupply: totalSupply,
            decimals: decimals,
            owner: owner,
            network: this.networkConfig.name,
            website: this.networkConfig.website,
            explorerUrl: `${this.networkConfig.explorerUrl}/token/${tokenId}`
        };
    }
    
    generateTokenId() {
        const random = crypto.randomBytes(16).toString('hex');
        const hash = crypto.createHash('sha256')
            .update(random + Date.now().toString() + this.networkConfig.chainId)
            .digest('hex');
        return `BRAD_${hash.substring(0, 32)}`;
    }
    
    // Transfer tokens
    transferToken(tokenId, from, to, amount) {
        const token = this.tokens.get(tokenId);
        if (!token) {
            throw new Error(`Token ${tokenId} not found on Bradichain`);
        }
        
        const fromBalance = token.balances.get(from) || 0;
        if (fromBalance < amount) {
            throw new Error(`Insufficient token balance. Balance: ${fromBalance}, Required: ${amount}`);
        }
        
        // Update balances
        token.balances.set(from, fromBalance - amount);
        token.balances.set(to, (token.balances.get(to) || 0) + amount);
        
        // Update holders count
        if (!token.balances.has(to) || token.balances.get(to) === amount) {
            token.holders++;
        }
        
        token.transactions++;
        
        const transferId = crypto.randomBytes(16).toString('hex');
        
        console.log(`[Bradichain Token] Transfer: ${amount} ${token.symbol} from ${from} to ${to}`);
        
        return {
            transferId: transferId,
            token: token.symbol,
            tokenName: token.name,
            from: from,
            to: to,
            amount: amount,
            timestamp: Date.now(),
            network: this.networkConfig.name,
            website: this.networkConfig.website,
            explorerUrl: `${this.networkConfig.explorerUrl}/transfer/${transferId}`
        };
    }
    
    // Get token balance
    getTokenBalance(tokenId, address) {
        const token = this.tokens.get(tokenId);
        if (!token) {
            throw new Error(`Token ${tokenId} not found on Bradichain`);
        }
        
        const balance = token.balances.get(address) || 0;
        
        return {
            token: token.name,
            symbol: token.symbol,
            address: address,
            balance: balance,
            decimals: token.decimals,
            formattedBalance: balance / Math.pow(10, token.decimals),
            network: this.networkConfig.name,
            website: this.networkConfig.website
        };
    }
    
    // Get token info
    getTokenInfo(tokenId) {
        const token = this.tokens.get(tokenId);
        if (!token) {
            throw new Error(`Token ${tokenId} not found on Bradichain`);
        }
        
        return {
            id: token.id,
            name: token.name,
            symbol: token.symbol,
            totalSupply: token.totalSupply,
            decimals: token.decimals,
            owner: token.owner,
            holders: token.holders,
            transactions: token.transactions,
            createdAt: new Date(token.createdAt).toISOString(),
            network: this.networkConfig.name,
            website: this.networkConfig.website,
            explorerUrl: `${this.networkConfig.explorerUrl}/token/${tokenId}`
        };
    }
    
    // Get all tokens
    getAllTokens() {
        const tokens = [];
        for (const token of this.tokens.values()) {
            tokens.push({
                id: token.id,
                name: token.name,
                symbol: token.symbol,
                totalSupply: token.totalSupply,
                holders: token.holders,
                network: token.network
            });
        }
        return {
            tokens: tokens,
            count: tokens.length,
            network: this.networkConfig.name,
            website: this.networkConfig.website
        };
    }
    
    // ========== 4. CONTRACT QUERIES ==========
    
    getContractInfo(contractId) {
        const contract = this.contracts.get(contractId);
        if (!contract) {
            throw new Error(`Contract ${contractId} not found on Bradichain`);
        }
        
        return {
            id: contract.id,
            owner: contract.owner,
            status: contract.status,
            transactions: contract.transactions,
            balance: contract.balance,
            gasUsed: contract.gasUsed,
            abi: contract.abi,
            createdAt: new Date(contract.createdAt).toISOString(),
            network: this.networkConfig.name,
            website: this.networkConfig.website,
            explorerUrl: `${this.networkConfig.explorerUrl}/contract/${contractId}`
        };
    }
    
    getContractStorage(contractId) {
        const contract = this.contracts.get(contractId);
        if (!contract) {
            throw new Error(`Contract ${contractId} not found on Bradichain`);
        }
        
        return Array.from(contract.storage.entries()).map(([key, value]) => ({
            key: key,
            value: value
        }));
    }
    
    getContractExecutions(contractId, limit = 10) {
        const executions = [];
        for (const exec of this.contractExecutions.values()) {
            if (exec.contractId === contractId) {
                executions.push(exec);
                if (executions.length >= limit) break;
            }
        }
        return {
            contractId: contractId,
            executions: executions,
            count: executions.length,
            network: this.networkConfig.name,
            explorerUrl: `${this.networkConfig.explorerUrl}/contract/${contractId}`
        };
    }
    
    // ========== 5. HELPER FUNCTIONS ==========
    
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
    
    // Get network info
    getNetworkInfo() {
        return {
            name: this.networkConfig.name,
            website: this.networkConfig.website,
            apiEndpoint: this.networkConfig.apiEndpoint,
            explorerUrl: this.networkConfig.explorerUrl,
            docsUrl: this.networkConfig.docsUrl,
            version: this.networkConfig.version,
            chainId: this.networkConfig.chainId,
            gasPrices: this.gasPrices,
            totalContracts: this.contracts.size,
            totalTokens: this.tokens.size,
            totalExecutions: this.contractExecutions.size
        };
    }
    
    // Get statistics
    getStatistics() {
        return {
            network: this.networkConfig.name,
            website: this.networkConfig.website,
            totalContracts: this.contracts.size,
            totalTokens: this.tokens.size,
            totalExecutions: this.contractExecutions.size,
            activeContracts: Array.from(this.contracts.values()).filter(c => c.status === 'active').length,
            totalTokenSupply: Array.from(this.tokens.values()).reduce((sum, t) => sum + t.totalSupply, 0),
            totalTokenHolders: Array.from(this.tokens.values()).reduce((sum, t) => sum + t.holders, 0),
            lastUpdated: new Date().toISOString()
        };
    }
}

module.exports = SmartContractEngine;
