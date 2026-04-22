// bradicoin-sdk.js
// Official Bradicoin SDK for JavaScript/Node.js developers

class BradicoinSDK {
    constructor(config) {
        if (!config.apiKey || !config.apiSecret) {
            throw new Error('API Key and Secret are required');
        }
        
        this.apiKey = config.apiKey;
        this.apiSecret = config.apiSecret;
        this.baseUrl = config.baseUrl || 'https://bradicoin-api.onrender.com/api/developer';
        this.timeout = config.timeout || 30000;
    }
    
    async request(endpoint, options = {}) {
        const url = `${this.baseUrl}${endpoint}`;
        const headers = {
            'Content-Type': 'application/json',
            'X-API-Key': this.apiKey,
            'X-API-Secret': this.apiSecret,
            ...options.headers
        };
        
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.timeout);
        
        try {
            const response = await fetch(url, {
                ...options,
                headers,
                signal: controller.signal
            });
            
            clearTimeout(timeoutId);
            const data = await response.json();
            
            if (!response.ok) {
                throw new Error(data.error || `HTTP ${response.status}`);
            }
            
            return data;
        } catch (error) {
            clearTimeout(timeoutId);
            throw error;
        }
    }
    
    // Create payment link
    async createPayment(params) {
        return this.request('/create-payment', {
            method: 'POST',
            body: JSON.stringify(params)
        });
    }
    
    // Check payment status
    async getPayment(paymentId) {
        return this.request(`/payment/${paymentId}`);
    }
    
    // Send BRD transaction
    async sendTransaction(params) {
        return this.request('/send', {
            method: 'POST',
            body: JSON.stringify(params)
        });
    }
    
    // Get balance
    async getBalance(address) {
        return this.request(`/balance/${address}`);
    }
    
    // Get transaction status
    async getTransaction(txId) {
        return this.request(`/transaction/${txId}`);
    }
    
    // Get transaction history
    async getHistory(address, limit = 50, offset = 0) {
        return this.request(`/history/${address}?limit=${limit}&offset=${offset}`);
    }
    
    // Get network info
    async getNetworkInfo() {
        return this.request('/network');
    }
    
    // Get BRD price
    async getPrice() {
        return this.request('/price');
    }
    
    // Estimate fee
    async estimateFee(amount) {
        return this.request('/estimate-fee', {
            method: 'POST',
            body: JSON.stringify({ amount })
        });
    }
    
    // Create new wallet
    async createWallet() {
        return this.request('/create-wallet', {
            method: 'POST'
        });
    }
    
    // Get all payments
    async getPayments(status = null, limit = 50) {
        const url = status ? `/payments?status=${status}&limit=${limit}` : `/payments?limit=${limit}`;
        return this.request(url);
    }
    
    // Test webhook
    async testWebhook(webhookUrl) {
        return this.request('/test-webhook', {
            method: 'POST',
            body: JSON.stringify({ webhookUrl })
        });
    }
    
    // Get webhook logs
    async getWebhookLogs(limit = 50) {
        return this.request(`/webhook-logs?limit=${limit}`);
    }
}

module.exports = BradicoinSDK;
