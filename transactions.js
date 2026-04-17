/**
 * Public Transactions Module - BradiCoin Blockchain
 * Deposits, withdrawals, transfers and public queries
 * @version 1.0.0
 */

const crypto = require('crypto');

class PublicTransactions {
  constructor(blockchainInstance) {
    this.blockchain = blockchainInstance;
    this.publicBalances = new Map(); // address -> balance
  }

  /**
   * PUBLIC DEPOSIT
   * @param {string} toAddress - Destination address
   * @param {number} amount - Amount in BradiCoins
   */
  async deposit(toAddress, amount) {
    // Validations
    if (!this.isValidAddress(toAddress)) {
      throw new Error('Invalid address');
    }
    if (amount <= 0) {
      throw new Error('Amount must be greater than zero');
    }
    if (amount > 1000000) {
      throw new Error('Maximum deposit is 1,000,000 BradiCoins');
    }

    // Get current balance
    const currentBalance = await this.getBalance(toAddress);
    const newBalance = currentBalance + amount;

    // Update balance
    this.publicBalances.set(toAddress, newBalance);

    // Record on blockchain
    const txHash = this.generateTxHash();
    await this.recordTransaction({
      type: 'DEPOSIT',
      to: toAddress,
      amount: amount,
      txHash: txHash,
      timestamp: Date.now()
    });

    // Emit event
    await this.emitEvent('DepositCompleted', {
      toAddress,
      amount,
      newBalance,
      txHash,
      timestamp: Date.now()
    });

    return {
      success: true,
      txHash: txHash,
      toAddress,
      amount,
      newBalance,
      message: `✅ Deposit of ${amount} BradiCoins completed successfully!`
    };
  }

  /**
   * PUBLIC TRANSFER (SEND)
   * @param {string} fromAddress - Source address
   * @param {string} toAddress - Destination address
   * @param {number} amount - Amount in BradiCoins
   */
  async transfer(fromAddress, toAddress, amount) {
    // Validations
    if (!this.isValidAddress(fromAddress)) {
      throw new Error('Invalid source address');
    }
    if (!this.isValidAddress(toAddress)) {
      throw new Error('Invalid destination address');
    }
    if (fromAddress === toAddress) {
      throw new Error('❌ Cannot transfer to yourself');
    }
    if (amount <= 0) {
      throw new Error('Amount must be greater than zero');
    }

    // Check balance
    const fromBalance = await this.getBalance(fromAddress);
    if (fromBalance < amount) {
      throw new Error(`❌ Insufficient balance. Current balance: ${fromBalance} BradiCoins`);
    }

    // Calculate fee (0.1%)
    const fee = this.calculateFee(amount);
    const totalDeduct = amount + fee;

    if (fromBalance < totalDeduct) {
      throw new Error(`❌ Insufficient balance to cover fee. Required: ${totalDeduct}`);
    }

    // Update balances
    const newFromBalance = fromBalance - totalDeduct;
    const toBalance = await this.getBalance(toAddress);
    const newToBalance = toBalance + amount;

    this.publicBalances.set(fromAddress, newFromBalance);
    this.publicBalances.set(toAddress, newToBalance);

    // Record on blockchain
    const txHash = this.generateTxHash();
    await this.recordTransaction({
      type: 'TRANSFER',
      from: fromAddress,
      to: toAddress,
      amount: amount,
      fee: fee,
      txHash: txHash,
      timestamp: Date.now()
    });

    // Emit event
    await this.emitEvent('TransferCompleted', {
      txHash,
      fromAddress,
      toAddress,
      amount,
      fee,
      newFromBalance,
      newToBalance,
      timestamp: Date.now()
    });

    return {
      success: true,
      txHash: txHash,
      fromAddress,
      toAddress,
      amount,
      fee,
      newFromBalance,
      newToBalance,
      message: `✅ Transfer of ${amount} BradiCoins completed! Fee: ${fee} BradiCoins`
    };
  }

  /**
   * GET PUBLIC BALANCE
   * @param {string} address - Wallet address
   */
  async getBalance(address) {
    if (!this.isValidAddress(address)) {
      throw new Error('Invalid address');
    }
    return this.publicBalances.get(address) || 0;
  }

  /**
   * TRANSACTION HISTORY
   * @param {string} address - Wallet address
   * @param {number} limit - Transaction limit
   */
  async getTransactionHistory(address, limit = 50) {
    if (!this.isValidAddress(address)) {
      throw new Error('Invalid address');
    }

    const allTxs = await this.blockchain?.getTransactions() || [];
    
    const userTxs = allTxs
      .filter(tx => tx.from === address || tx.to === address)
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, limit);

    return {
      address,
      totalTransactions: userTxs.length,
      transactions: userTxs
    };
  }

  /**
   * CALCULATE FEE
   */
  calculateFee(amount) {
    const fee = amount * 0.001; // 0.1%
    return Math.max(0.01, Math.min(fee, 10)); // Minimum 0.01, Maximum 10
  }

  /**
   * GENERATE TRANSACTION HASH
   */
  generateTxHash() {
    return '0x' + crypto.randomBytes(32).toString('hex');
  }

  /**
   * RECORD TRANSACTION ON BLOCKCHAIN
   */
  async recordTransaction(transaction) {
    if (this.blockchain && this.blockchain.addTransaction) {
      await this.blockchain.addTransaction(transaction);
    }
    console.log('[Transaction] Recorded:', transaction);
  }

  /**
   * EMIT EVENT
   */
  async emitEvent(eventName, eventData) {
    if (this.blockchain && this.blockchain.emitEvent) {
      await this.blockchain.emitEvent(eventName, eventData);
    }
    console.log(`[Transaction] Event: ${eventName}`, eventData);
  }

  /**
   * VALIDATE ADDRESS
   */
  isValidAddress(address) {
    return /^0x[a-fA-F0-9]{40}$/.test(address) || /^[a-fA-F0-9]{64}$/.test(address);
  }

  /**
   * LIST ALL WALLETS
   */
  getAllWallets() {
    const wallets = [];
    for (const [address, balance] of this.publicBalances.entries()) {
      wallets.push({ address, balance });
    }
    return wallets;
  }

  /**
   * TOTAL NETWORK SUPPLY
   */
  getTotalSupply() {
    let total = 0;
    for (const balance of this.publicBalances.values()) {
      total += balance;
    }
    return total;
  }
}

module.exports = PublicTransactions;
