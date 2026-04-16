class StakingManager {
    constructor(blockchain) {
        this.blockchain = blockchain;
        this.stakes = new Map(); // address -> { amount, startTime, lastReward, totalRewardsEarned }
        this.stakingAPY = 0.05; // 5% annual percentage yield
        this.rewardsPerBlock = 1; // 1 BRC rewarded per block mined
        this.minStakeAmount = 10; // Minimum 10 BRC to stake
    }

    // Stake coins
    stake(address, amount) {
        // Validate amount
        if (amount <= 0) {
            throw new Error('Amount must be greater than 0');
        }
        
        if (amount < this.minStakeAmount) {
            throw new Error(`Minimum stake amount is ${this.minStakeAmount} BRC`);
        }
        
        // Check balance
        const balance = this.blockchain.getBalance(address);
        if (balance < amount) {
            throw new Error(`Insufficient balance. You have ${balance} BRC`);
        }
        
        // Create stake transaction
        const stakeTransaction = {
            fromAddress: address,
            toAddress: 'staking-contract',
            amount: amount,
            type: 'STAKE',
            timestamp: new Date().toISOString()
        };
        
        this.blockchain.addTransaction(stakeTransaction);
        
        // Record or update stake
        if (this.stakes.has(address)) {
            const currentStake = this.stakes.get(address);
            currentStake.amount += amount;
            currentStake.startTime = new Date();
        } else {
            this.stakes.set(address, {
                amount: amount,
                startTime: new Date(),
                lastReward: new Date(),
                totalRewardsEarned: 0
            });
        }
        
        return {
            success: true,
            message: `${amount} BRC staked successfully`,
            totalStaked: this.stakes.get(address).amount,
            apy: this.stakingAPY * 100 + '%'
        };
    }
    
    // Unstake and claim rewards
    unstake(address) {
        if (!this.stakes.has(address)) {
            throw new Error('No active stake found for this address');
        }
        
        const stake = this.stakes.get(address);
        const rewards = this.calculateRewards(address);
        const totalToReturn = stake.amount + rewards;
        
        // Return staked amount + rewards
        const unstakeTransaction = {
            fromAddress: 'staking-contract',
            toAddress: address,
            amount: totalToReturn,
            type: 'UNSTAKE',
            timestamp: new Date().toISOString()
        };
        
        this.blockchain.addTransaction(unstakeTransaction);
        
        // Remove stake record
        this.stakes.delete(address);
        
        return {
            success: true,
            message: `Unstaked ${stake.amount} BRC + ${rewards} BRC rewards`,
            totalReceived: totalToReturn,
            stakedAmount: stake.amount,
            rewards: rewards
        };
    }
    
    // Calculate rewards for a specific address
    calculateRewards(address) {
        if (!this.stakes.has(address)) {
            return 0;
        }
        
        const stake = this.stakes.get(address);
        const now = new Date();
        const hoursStaked = (now - stake.startTime) / (1000 * 60 * 60);
        
        // APY calculation: amount * APY * (hours / 8760 hours per year)
        const annualReward = stake.amount * this.stakingAPY;
        const hourlyRate = annualReward / 8760;
        const rewards = Math.floor(hourlyRate * hoursStaked);
        
        return rewards;
    }
    
    // Get complete staking information for an address
    getStakingInfo(address) {
        if (!this.stakes.has(address)) {
            return {
                hasStake: false,
                message: 'No active stake found for this address'
            };
        }
        
        const stake = this.stakes.get(address);
        const currentRewards = this.calculateRewards(address);
        const hoursStaked = Math.floor((new Date() - stake.startTime) / (1000 * 60 * 60));
        const daysStaked = Math.floor(hoursStaked / 24);
        
        return {
            hasStake: true,
            stakedAmount: stake.amount,
            startTime: stake.startTime,
            startDate: stake.startTime.toLocaleDateString(),
            hoursStaked: hoursStaked,
            daysStaked: daysStaked,
            currentRewards: currentRewards,
            totalValue: stake.amount + currentRewards,
            totalRewardsEarned: stake.totalRewardsEarned,
            apy: this.stakingAPY * 100 + '%',
            estimatedNextReward: Math.floor(currentRewards * 0.01) // 1% of current rewards
        };
    }
    
    // Distribute rewards to all stakers (called when a block is mined)
    distributeRewards(minerAddress) {
        const totalRewards = this.rewardsPerBlock;
        let distributed = 0;
        
        if (this.getTotalStaked() === 0) {
            return {
                blockReward: totalRewards,
                distributedToStakers: 0,
                remainingToMiner: totalRewards,
                message: 'No active stakes to distribute rewards'
            };
        }
        
        for (const [address, stake] of this.stakes) {
            const share = (stake.amount / this.getTotalStaked()) * totalRewards;
            const reward = Math.floor(share);
            
            if (reward > 0) {
                const rewardTransaction = {
                    fromAddress: 'staking-contract',
                    toAddress: address,
                    amount: reward,
                    type: 'STAKING_REWARD',
                    timestamp: new Date().toISOString()
                };
                
                this.blockchain.addTransaction(rewardTransaction);
                stake.totalRewardsEarned += reward;
                stake.lastReward = new Date();
                distributed += reward;
            }
        }
        
        return {
            blockReward: totalRewards,
            distributedToStakers: distributed,
            remainingToMiner: totalRewards - distributed,
            stakersCount: this.stakes.size,
            message: `${distributed} BRC distributed to ${this.stakes.size} stakers`
        };
    }
    
    // Get total staked across all addresses
    getTotalStaked() {
        let total = 0;
        for (const stake of this.stakes.values()) {
            total += stake.amount;
        }
        return total;
    }
    
    // Get number of active stakers
    getActiveStakersCount() {
        return this.stakes.size;
    }
    
    // Update APY (annual percentage yield)
    updateAPY(newAPY) {
        if (newAPY >= 0 && newAPY <= 1) {
            this.stakingAPY = newAPY;
            return { 
                success: true, 
                newAPY: newAPY * 100 + '%',
                message: `APY updated to ${newAPY * 100}%`
            };
        }
        throw new Error('APY must be between 0 and 1 (0% to 100%)');
    }
    
    // Update minimum stake amount
    updateMinStake(newMinAmount) {
        if (newMinAmount > 0 && newMinAmount <= 10000) {
            this.minStakeAmount = newMinAmount;
            return {
                success: true,
                newMinStake: newMinAmount,
                message: `Minimum stake amount updated to ${newMinAmount} BRC`
            };
        }
        throw new Error('Minimum stake amount must be between 1 and 10000 BRC');
    }
    
    // Update rewards per block
    updateRewardsPerBlock(newRewardAmount) {
        if (newRewardAmount > 0 && newRewardAmount <= 100) {
            this.rewardsPerBlock = newRewardAmount;
            return {
                success: true,
                newRewardPerBlock: newRewardAmount,
                message: `Block reward updated to ${newRewardAmount} BRC`
            };
        }
        throw new Error('Reward per block must be between 1 and 100 BRC');
    }
    
    // Get all stakers (for admin purposes)
    getAllStakers() {
        const stakers = [];
        for (const [address, stake] of this.stakes) {
            stakers.push({
                address: address,
                stakedAmount: stake.amount,
                startTime: stake.startTime,
                totalRewardsEarned: stake.totalRewardsEarned,
                currentRewards: this.calculateRewards(address)
            });
        }
        return stakers;
    }
    
    // Get staking statistics
    getStakingStats() {
        return {
            totalStaked: this.getTotalStaked(),
            activeStakers: this.getActiveStakersCount(),
            currentAPY: this.stakingAPY * 100 + '%',
            rewardsPerBlock: this.rewardsPerBlock,
            minStakeAmount: this.minStakeAmount,
            totalRewardsDistributed: this.calculateTotalRewardsDistributed()
        };
    }
    
    // Calculate total rewards distributed to all stakers
    calculateTotalRewardsDistributed() {
        let total = 0;
        for (const stake of this.stakes.values()) {
            total += stake.totalRewardsEarned;
        }
        return total;
    }
    
    // Check if address has active stake
    hasActiveStake(address) {
        return this.stakes.has(address);
    }
    
    // Get stake details without rewards calculation
    getRawStake(address) {
        return this.stakes.get(address) || null;
    }
}

module.exports = StakingManager;
