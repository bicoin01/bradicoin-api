// ============================================
// LOAD ENVIRONMENT VARIABLES
// ============================================
require('dotenv').config();

// ============================================
// IMPORTS
// ============================================
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

// ============================================
// IMPORT NEW MODULES
// ============================================
const HashManager = require('./hash');
const BradicoinChecksum = require('./checksum');
const BradicoinValidator = require('./validator');
const BradicoinEncoding = require('./encoding');
const BradicoinWallet = require('./wallet');

// ============================================
// ENVIRONMENT VARIABLES VALIDATION
// ============================================
const requiredEnvVars = ['RPC_URL', 'CHAIN_ID'];
const missingVars = requiredEnvVars.filter(env => !process.env[env]);

if (missingVars.length > 0) {
    console.error('❌ ERROR: Required environment variables missing:');
    missingVars.forEach(v => console.error(`   - ${v}`));
    console.error('\n💡 Configure in .env or Render environment variables');
    process.exit(1);
}

// ============================================
// CONFIGURATION
// ============================================
const config = {
    // Server
    port: process.env.PORT || 3000,
    host: process.env.HOST || '0.0.0.0',
    nodeEnv: process.env.NODE_ENV || 'development',
    
    // RPC
    rpcUrl: process.env.RPC_URL,
    rpcHost: process.env.RPC_HOST || '0.0.0.0',
    rpcPort: parseInt(process.env.RPC_PORT) || 8545,
    chainId: parseInt(process.env.CHAIN_ID) || 1337,
    
    // Blockchain
    dataDir: process.env.BRADICOIN_DATA_DIR || './bradicoin-data',
    coinName: process.env.COIN_NAME || 'Bradicoin',
    coinSymbol: process.env.COIN_SYMBOL || 'BRD',
    decimals: parseInt(process.env.DECIMALS) || 18,
    totalSupply: parseInt(process.env.TOTAL_SUPPLY) || 21000000,
    blockTime: parseInt(process.env.BLOCK_TIME) || 10,
    
    // Security
    jwtSecret: process.env.JWT_SECRET || 'dev_secret_change_in_production',
    apiKey: process.env.API_KEY,
    encryptionKey: process.env.ENCRYPTION_KEY,
    
    // Database
    mongoUri: process.env.MONGODB_URI,
    redisUrl: process.env.REDIS_URL,
    
    // External Services
    infuraKey: process.env.INFURA_KEY,
    etherscanKey: process.env.ETHERSCAN_KEY,
    
    // Network
    network: process.env.NETWORK || 'mainnet'
};

console.log('📋 Configuration loaded:');
console.log(`   🚀 Server: ${config.host}:${config.port}`);
console.log(`   🔗 RPC URL: ${config.rpcUrl}`);
console.log(`   ⛓️  Chain ID: ${config.chainId}`);
console.log(`   🪙  Coin: ${config.coinName} (${config.coinSymbol})`);
console.log(`   📁 Data Dir: ${config.dataDir}`);
console.log(`   🌎 Environment: ${config.nodeEnv}`);
console.log(`   🔗 Network: ${config.network}`);

// ============================================
// INITIALIZE MODULES
// ============================================
const hashManager = new HashManager();
const checksumManager = new BradicoinChecksum();
const validator = new BradicoinValidator(config.network);
const encoding = new BradicoinEncoding(config.network);
const wallet = new BradicoinWallet(config.network);

console.log('✅ Modules initialized:');
console.log(`   🔐 Hash Manager: OK`);
console.log(`   ✅ Checksum Manager: OK`);
console.log(`   ✅ Validator: OK`);
console.log(`   📝 Encoding: OK`);
console.log(`   💳 Wallet: OK`);

// ============================================
// INITIALIZE APP
// ============================================
const app = express();

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Request logging middleware
app.use((req, res, next) => {
    console.log(`📥 ${req.method} ${req.path}`);
    if (req.body && Object.keys(req.body).length > 0 && req.path !== '/api/register') {
        console.log(`   Body:`, JSON.stringify(req.body).substring(0, 200));
    }
    if (req.query && Object.keys(req.query).length > 0) {
        console.log(`   Query:`, req.query);
    }
    next();
});

// ============================================
// PERSISTENT DATABASE (File-based)
// ============================================
const DATA_FILE = path.join(config.dataDir, 'usuarios.json');

// Ensure data directory exists
if (!fs.existsSync(config.dataDir)) {
    fs.mkdirSync(config.dataDir, { recursive: true });
    console.log(`📁 Created data directory: ${config.dataDir}`);
}

// Load users from file
function loadUsers() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            const data = fs.readFileSync(DATA_FILE, 'utf8');
            const users = JSON.parse(data);
            console.log(`📊 Loaded ${users.length} users from database`);
            return users;
        }
    } catch (error) {
        console.error('❌ Error loading users:', error.message);
    }
    return [];
}

// Save users to file
function saveUsers(users) {
    try {
        fs.writeFileSync(DATA_FILE, JSON.stringify(users, null, 2));
        console.log(`💾 Saved ${users.length} users to database`);
    } catch (error) {
        console.error('❌ Error saving users:', error.message);
    }
}

// Initialize users
let users = loadUsers();

// ============================================
// HEALTH CHECK ENDPOINT
// ============================================
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        config: {
            coin: config.coinName,
            symbol: config.coinSymbol,
            chainId: config.chainId,
            rpcUrl: config.rpcUrl,
            environment: config.nodeEnv,
            network: config.network
        },
        modules: {
            hash: true,
            checksum: true,
            validator: true,
            encoding: true,
            wallet: true
        },
        stats: {
            totalUsers: users.length,
            dataDir: config.dataDir,
            rpcConnected: !!config.rpcUrl
        }
    });
});

// ============================================
// MAIN ROUTE
// ============================================
app.get('/', (req, res) => {
    res.json({
        name: config.coinName,
        version: '2.0.0',
        status: 'online',
        currency: config.coinSymbol,
        chainId: config.chainId,
        rpc: config.rpcUrl,
        network: config.network,
        modules: ['hash', 'checksum', 'validator', 'encoding', 'wallet'],
        endpoints: {
            health: 'GET /health',
            register: 'POST /api/register',
            balance: 'GET /api/balance/:address',
            send: 'POST /api/send',
            users: 'GET /api/users',
            transactions: 'GET /api/transactions/:address',
            // New endpoints
            wallet: {
                create: 'POST /api/wallet/create',
                verify: 'POST /api/wallet/verify',
                wif: 'POST /api/wallet/wif',
                detect: 'POST /api/wallet/detect'
            },
            hash: {
                sha256: 'POST /api/hash/sha256',
                hash160: 'POST /api/hash/hash160',
                hash256: 'POST /api/hash/hash256',
                hmac: 'POST /api/hash/hmac',
                merkle: 'POST /api/hash/merkle'
            },
            checksum: {
                verify: 'POST /api/checksum/verify',
                fix: 'POST /api/checksum/fix'
            },
            encode: {
                base58: 'POST /api/encode/base58',
                decode: 'POST /api/decode/base58',
                hex: 'POST /api/encode/hex'
            },
            validate: {
                transaction: 'POST /api/validate/transaction'
            }
        },
        message: 'Bradicoin API v2.0 - Now with advanced cryptography!'
    });
});

// ============================================
// ============================================
// WALLET ENDPOINTS (NEW)
// ============================================

// 1. Generate wallet address
app.post('/api/wallet/create', (req, res) => {
    try {
        const { publicKey } = req.body;
        
        if (!publicKey) {
            return res.status(400).json({
                success: false,
                error: 'Public key is required'
            });
        }

        const result = wallet.generateAddress(publicKey);
        res.json(result);
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// 2. Verify address
app.post('/api/wallet/verify', (req, res) => {
    try {
        const { address } = req.body;
        
        if (!address) {
            return res.status(400).json({
                success: false,
                error: 'Address is required'
            });
        }

        const result = wallet.verifyAddress(address);
        res.json(result);
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// 3. Generate WIF
app.post('/api/wallet/wif', (req, res) => {
    try {
        const { privateKey, compressed = true } = req.body;
        
        if (!privateKey) {
            return res.status(400).json({
                success: false,
                error: 'Private key is required'
            });
        }

        const wif = wallet.generateWIF(privateKey, compressed);
        res.json({
            success: true,
            wif: wif,
            compressed: compressed
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// 4. Detect address type
app.post('/api/wallet/detect', (req, res) => {
    try {
        const { address } = req.body;
        
        if (!address) {
            return res.status(400).json({
                success: false,
                error: 'Address is required'
            });
        }

        const result = wallet.detectAddressType(address);
        res.json(result);
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// 5. Generate key pair
app.post('/api/wallet/generate-keys', (req, res) => {
    try {
        const result = wallet.generateKeyPair();
        res.json(result);
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// 6. Import from private key
app.post('/api/wallet/import', (req, res) => {
    try {
        const { privateKey, compressed = true } = req.body;
        
        if (!privateKey) {
            return res.status(400).json({
                success: false,
                error: 'Private key is required'
            });
        }

        const result = wallet.importFromPrivateKey(privateKey, compressed);
        res.json(result);
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// ============================================
// HASH ENDPOINTS (NEW)
// ============================================

// 1. SHA-256
app.post('/api/hash/sha256', (req, res) => {
    try {
        const { data, encoding = 'hex' } = req.body;
        if (!data) {
            return res.status(400).json({ success: false, error: 'Data is required' });
        }
        const result = hashManager.sha256(data, encoding);
        res.json({ 
            success: true, 
            algorithm: 'SHA-256',
            result: result 
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 2. HASH160 (SHA-256 + RIPEMD-160)
app.post('/api/hash/hash160', (req, res) => {
    try {
        const { data, encoding = 'hex' } = req.body;
        if (!data) {
            return res.status(400).json({ success: false, error: 'Data is required' });
        }
        const result = hashManager.hash160(data, encoding);
        res.json({ 
            success: true, 
            algorithm: 'HASH160 (SHA-256 + RIPEMD-160)',
            result: result 
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 3. Double SHA-256
app.post('/api/hash/hash256', (req, res) => {
    try {
        const { data, encoding = 'hex' } = req.body;
        if (!data) {
            return res.status(400).json({ success: false, error: 'Data is required' });
        }
        const result = hashManager.hash256(data, encoding);
        res.json({ 
            success: true, 
            algorithm: 'HASH256 (Double SHA-256)',
            result: result 
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 4. HMAC-SHA256
app.post('/api/hash/hmac', (req, res) => {
    try {
        const { key, data, encoding = 'hex' } = req.body;
        if (!key || !data) {
            return res.status(400).json({ success: false, error: 'Key and data are required' });
        }
        const result = hashManager.hmacSha256(key, data, encoding);
        res.json({ 
            success: true, 
            algorithm: 'HMAC-SHA256',
            result: result 
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 5. Merkle Root
app.post('/api/hash/merkle', (req, res) => {
    try {
        const { transactions, encoding = 'hex' } = req.body;
        if (!transactions || !Array.isArray(transactions)) {
            return res.status(400).json({ success: false, error: 'Transactions array is required' });
        }
        const result = hashManager.merkleRoot(transactions, encoding);
        res.json({ 
            success: true, 
            algorithm: 'Merkle Root',
            result: result 
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 6. BIP39 Seed
app.post('/api/hash/bip39', (req, res) => {
    try {
        const { mnemonic, passphrase = '', encoding = 'hex' } = req.body;
        if (!mnemonic) {
            return res.status(400).json({ success: false, error: 'Mnemonic phrase is required' });
        }
        const result = hashManager.bip39Seed(mnemonic, passphrase, encoding);
        res.json({ 
            success: true, 
            algorithm: 'BIP39 Seed',
            result: result 
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================
// CHECKSUM ENDPOINTS (NEW)
// ============================================

// 1. Verify address checksum
app.post('/api/checksum/verify', (req, res) => {
    try {
        const { address } = req.body;
        if (!address) {
            return res.status(400).json({ success: false, error: 'Address is required' });
        }
        const result = checksumManager.verifyAddressChecksum(address);
        res.json(result);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 2. Fix address with wrong checksum
app.post('/api/checksum/fix', (req, res) => {
    try {
        const { address } = req.body;
        if (!address) {
            return res.status(400).json({ success: false, error: 'Address is required' });
        }
        const result = checksumManager.validateAndFixAddress(address);
        res.json(result);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 3. Generate transaction checksum
app.post('/api/checksum/transaction', (req, res) => {
    try {
        const { transactionData } = req.body;
        if (!transactionData) {
            return res.status(400).json({ success: false, error: 'Transaction data is required' });
        }
        const result = checksumManager.generateTransactionChecksum(transactionData);
        res.json({ success: true, ...result });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 4. Verify transaction checksum
app.post('/api/checksum/verify-tx', (req, res) => {
    try {
        const { fullHash } = req.body;
        if (!fullHash) {
            return res.status(400).json({ success: false, error: 'Full hash is required' });
        }
        const result = checksumManager.verifyTransactionChecksum(fullHash);
        res.json(result);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================
// ENCODING ENDPOINTS (NEW)
// ============================================

// 1. Encode to Base58Check
app.post('/api/encode/base58', (req, res) => {
    try {
        const { data } = req.body;
        if (!data) {
            return res.status(400).json({ success: false, error: 'Data is required' });
        }
        const buffer = Buffer.from(data, 'hex');
        const payload = Buffer.concat([Buffer.from([0x00]), buffer]);
        const encoded = encoding.base58CheckEncode(payload);
        res.json({ success: true, encoded: encoded });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 2. Decode from Base58Check
app.post('/api/decode/base58', (req, res) => {
    try {
        const { address } = req.body;
        if (!address) {
            return res.status(400).json({ success: false, error: 'Address is required' });
        }
        const decoded = encoding.base58CheckDecode(address);
        res.json({ success: true, decoded: decoded });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 3. Convert to Hex
app.post('/api/encode/hex', (req, res) => {
    try {
        const { data, format = 'utf8' } = req.body;
        if (!data) {
            return res.status(400).json({ success: false, error: 'Data is required' });
        }
        let hex;
        if (format === 'utf8') {
            hex = encoding.toHex(data);
        } else {
            hex = encoding.toHex(Buffer.from(data, 'hex'));
        }
        res.json({ success: true, hex: hex });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 4. Bech32 encode
app.post('/api/encode/bech32', (req, res) => {
    try {
        const { witnessVersion, program, useBech32m = false } = req.body;
        if (witnessVersion === undefined || !program) {
            return res.status(400).json({ success: false, error: 'Witness version and program are required' });
        }
        const programBuffer = Buffer.from(program, 'hex');
        const encoded = encoding.bech32Encode(witnessVersion, programBuffer, useBech32m);
        res.json({ success: true, encoded: encoded });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================
// VALIDATION ENDPOINTS (NEW)
// ============================================

// 1. Validate transaction
app.post('/api/validate/transaction', (req, res) => {
    try {
        const { to, amount, fee, txHash } = req.body;
        const errors = [];
        
        if (to) {
            const addressValidation = validator.validateAddress(to);
            if (!addressValidation.valid) {
                errors.push({ field: 'to', error: addressValidation.error });
            }
        }
        
        if (amount) {
            const amountValidation = validator.validateAmount(amount, 0.00001);
            if (!amountValidation.valid) {
                errors.push({ field: 'amount', error: amountValidation.error });
            }
        }
        
        if (fee) {
            const feeValidation = validator.validateFee(fee);
            if (!feeValidation.valid) {
                errors.push({ field: 'fee', error: feeValidation.error });
            }
        }
        
        if (txHash) {
            const hashValidation = validator.validateTransactionHash(txHash);
            if (!hashValidation.valid) {
                errors.push({ field: 'txHash', error: hashValidation.error });
            }
        }
        
        if (errors.length > 0) {
            return res.status(400).json({ success: false, errors: errors });
        }
        
        res.json({ success: true, message: 'Transaction is valid' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 2. Validate address
app.post('/api/validate/address', (req, res) => {
    try {
        const { address } = req.body;
        if (!address) {
            return res.status(400).json({ success: false, error: 'Address is required' });
        }
        const result = validator.validateAddress(address);
        res.json(result);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 3. Validate private key
app.post('/api/validate/private-key', (req, res) => {
    try {
        const { privateKey } = req.body;
        if (!privateKey) {
            return res.status(400).json({ success: false, error: 'Private key is required' });
        }
        const result = validator.validatePrivateKey(privateKey);
        res.json(result);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 4. Validate public key
app.post('/api/validate/public-key', (req, res) => {
    try {
        const { publicKey } = req.body;
        if (!publicKey) {
            return res.status(400).json({ success: false, error: 'Public key is required' });
        }
        const result = validator.validatePublicKey(publicKey);
        res.json(result);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 5. Validate transaction hash
app.post('/api/validate/tx-hash', (req, res) => {
    try {
        const { txHash } = req.body;
        if (!txHash) {
            return res.status(400).json({ success: false, error: 'Transaction hash is required' });
        }
        const result = validator.validateTransactionHash(txHash);
        res.json(result);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================
// ORIGINAL ENDPOINTS (KEPT UNCHANGED)
// ============================================

// WALLET - Register User
app.post('/api/register', (req, res) => {
    try {
        const { username, password } = req.body;
        
        if (!username || !password) {
            return res.status(400).json({ 
                success: false, 
                error: 'Username and password are required' 
            });
        }
        
        if (username.length < 3) {
            return res.status(400).json({
                success: false,
                error: 'Username must be at least 3 characters'
            });
        }
        
        if (password.length < 6) {
            return res.status(400).json({
                success: false,
                error: 'Password must be at least 6 characters'
            });
        }
        
        const existingUser = users.find(u => u.username === username);
        if (existingUser) {
            return res.status(400).json({ 
                success: false, 
                error: 'Username already exists' 
            });
        }
        
        // Generate standard Bradicoin address (Base58Check)
        const privateKey = crypto.randomBytes(32).toString('hex');
        const publicKey = wallet._derivePublicKey(privateKey);
        const address = encoding.publicKeyToAddress(publicKey);
        
        // Generate 12-word seed phrase
        const wordList = ["abandon","ability","able","about","above","absent","absorb","abstract","absurd","abuse","access","accident","account","accuse","achieve","acid","acoustic","acquire","across","act","action","actor","actress","actual","adapt","add","addict","address","adjust","admit","adult","advance","advice","aerobic","affair","afford","afraid","again","age","agent","agree","ahead","aim","air","airport","aisle","alarm","album","alcohol","alert","alien","all","alley","allow","almost","alone","alpha","already","also","alter","always","amateur","amazing","among","amount","amused","analyst","anchor","ancient","anger","angle","angry","animal","ankle","announce","annual","another","answer","antenna","antique","anxiety","any","apart","apology","appear","apple","approve","april","arch","arctic","area","arena","argue","arm","armed","armor","army","around","arrange","arrest","arrive","arrow","art","artefact","artist","artwork","ask","aspect","assault","asset","assist","assume","asthma","athlete","atom","attack","attend","attitude","attract","auction","audit","august","aunt","author","auto","autumn","average","avocado","avoid","awake","aware","away","awesome","awful","awkward","axis","baby","bachelor","bacon","badge","bag","balance","balcony","ball","bamboo","banana","banner","bar","barely","bargain","barrel","base","basic","basket","battle","beach","bean","beauty","because","become","beef","before","begin","behave","behind","believe","below","belt","bench","benefit","best","betray","better","between","beyond","bicycle","bid","bike","bind","biology","bird","birth","bitter","black","blade","blame","blanket","blast","bleak","bless","blind","blood","blossom","blouse","blue","blur","blush","board","boat","body","boil","bomb","bone","bonus","book","boost","border","boring","borrow","boss","bottom","bounce","box","boy","bracket","brain","brand","brass","brave","bread","breeze","brick","bridge","brief","bright","bring","brisk","broccoli","broken","bronze","broom","brother","brown","brush","bubble","buddy","budget","buffalo","build","bulb","bulk","bullet","bundle","bunker","burden","burger","burst","bus","business","busy","butter","buyer","buzz","cabbage","cabin","cable","cactus","cage","cake","call","calm","camera","camp","can","canal","cancel","candy","cannon","canoe","canvas","canyon","capable","capital","captain","car","carbon","card","cargo","carpet","carry","cart","case","cash","casino","castle","casual","cat","catalog","catch","category","cattle","caught","cause","caution","cave","ceiling","celery","cement","census","century","cereal","certain","chair","chalk","champion","change","chaos","chapter","charge","chase","chat","cheap","check","cheese","chef","cherry","chest","chicken","chief","child","chimney","choice","choose","chronic","chuckle","chunk","churn","cigar","cinnamon","circle","citizen","city","civil","claim","clap","clarify","claw","clay","clean","clerk","clever","click","client","cliff","climb","clinic","clip","clock","clog","close","cloth","cloud","clown","club","clump","cluster","clutch","coach","coast","coconut","code","coffee","coil","coin","collect","color","column","combine","come","comfort","comic","common","company","concert","conduct","confirm","congress","connect","consider","control","convince","cook","cool","copper","copy","coral","core","corn","correct","cost","cotton","couch","country","couple","course","cousin","cover","coyote","crack","cradle","craft","cram","crane","crash","crater","crawl","crazy","cream","credit","creek","crew","cricket","crime","crisp","critic","crop","cross","crouch","crowd","crucial","cruel","cruise","crumble","crunch","crush","cry","crystal","cube","culture","cup","cupboard","curious","current","curtain","curve","cushion","custom","cute","cycle","dad","damage","damp","dance","danger","daring","dash","daughter","dawn","day","deal","debate","debris","decade","december","decide","decline","decorate","decrease","deer","defense","define","defy","degree","delay","deliver","demand","demise","denial","dentist","deny","depart","depend","deposit","depth","deputy","derive","describe","desert","design","desk","despair","destroy","detail","detect","develop","device","devote","diagram","dial","diamond","diary","dice","diesel","diet","differ","digital","dignity","dilemma","dinner","dinosaur","direct","dirt","disagree","discover","disease","dish","dismiss","disorder","display","distance","divert","divide","divorce","dizzy","doctor","document","dog","doll","dolphin","domain","donate","donkey","donor","door","dose","double","dove","draft","dragon","drama","drastic","draw","dream","dress","drift","drill","drink","drip","drive","drop","drum","dry","duck","dumb","dune","during","dust","dutch","duty","dwarf","dynamic","eager","eagle","early","earn","earth","easily","east","easy","echo","ecology","economy","edge","edit","educate","effort","egg","eight","either","elbow","elder","electric","elegant","element","elephant","elevator","elite","else","embark","embody","embrace","emerge","emotion","employ","empower","empty","enable","enact","end","endless","endorse","enemy","energy","enforce","engage","engine","enhance","enjoy","enlist","enough","enrich","enroll","ensure","enter","entire","entry","envelope","episode","equal","equip","era","erase","erode","erosion","error","erupt","escape","essay","essence","estate","eternal","ethics","evidence","evil","evoke","evolve","exact","example","excess","exchange","excite","exclude","excuse","execute","exercise","exhaust","exhibit","exile","exist","exit","exotic","expand","expect","expire","explain","expose","express","extend","extra","eye","eyebrow","fabric","face","faculty","fade","faint","faith","fall","false","fame","family","famous","fan","fancy","fantasy","farm","fashion","fat","fatal","father","fatigue","fault","favorite","feature","february","federal","fee","feed","feel","female","fence","festival","fetch","fever","few","fiber","fiction","field","figure","file","film","filter","final","find","fine","finger","finish","fire","firm","first","fiscal","fish","fit","fitness","fix","flag","flame","flash","flat","flavor","flee","flight","flip","float","flock","floor","flower","fluid","flush","fly","foam","focus","fog","foil","fold","follow","food","foot","force","forest","forget","fork","fortune","forum","forward","fossil","foster","found","fox","fragile","frame","frequent","fresh","friend","fringe","frog","front","frost","frown","frozen","fruit","fuel","fun","funny","furnace","fury","future","gadget","gain","galaxy","gallery","game","gap","garage","garbage","garden","garlic","garment","gas","gasp","gate","gather","gauge","gaze","general","genius","genre","gentle","genuine","gesture","ghost","giant","gift","giggle","ginger","giraffe","girl","give","glad","glance","glare","glass","glide","glimpse","globe","gloom","glory","glove","glow","glue","goat","goddess","gold","good","goose","gorilla","gospel","gossip","govern","gown","grab","grace","grain","grant","grape","grass","gravity","great","green","grid","grief","grit","grocery","group","grow","grunt","guard","guess","guide","guilt","guitar","gun","gym","habit","hair","half","hammer","hamster","hand","happy","harbor","hard","harsh","harvest","hat","have","hawk","hazard","head","health","heart","heavy","hedgehog","height","hello","helmet","help","hen","hero","hidden","high","hill","hint","hip","hire","history","hobby","hockey","hold","hole","holiday","hollow","home","honey","hood","hope","horn","horror","horse","hospital","host","hotel","hour","hover","hub","human","humble","humor","hundred","hungry","hunt","hurdle","hurry","hurt","husband","hybrid","ice","icon","idea","identify","idle","ignore","ill","illegal","illness","image","imitate","immense","immune","impact","impose","improve","impulse","inch","include","income","increase","index","indicate","indoor","industry","infant","inflict","inform","inhale","inherit","initial","inject","injury","inmate","inner","innocent","input","inquiry","insane","insect","inside","inspire","install","intact","interest","into","invest","invite","involve","iron","island","isolate","issue","item","ivory","jacket","jaguar","jar","jazz","jealous","jeans","jelly","jewel","job","join","joke","journey","joy","judge","juice","jump","jungle","junior","junk","just","kangaroo","keen","keep","ketchup","key","kick","kid","kidney","kind","kingdom","kiss","kit","kitchen","kite","kitten","kiwi","knee","knife","knock","know","lab","label","labor","ladder","lady","lake","lamp","language","laptop","large","later","latin","laugh","laundry","lava","law","lawn","lawsuit","layer","lazy","leader","leaf","learn","leave","lecture","left","leg","legal","legend","leisure","lemon","lend","length","lens","leopard","lesson","letter","level","liar","liberty","library","license","life","lift","light","like","limb","limit","link","lion","liquid","list","little","live","lizard","load","loan","lobster","local","lock","logic","lonely","long","loop","lottery","loud","lounge","love","loyal","lucky","luggage","lumber","lunar","lunch","luxury","lyrics","machine","mad","magic","magnet","maid","mail","main","major","make","mammal","man","manage","mandate","mango","mansion","manual","maple","marble","march","margin","marine","market","marriage","mask","mass","master","match","material","math","matrix","matter","maximum","maze","meadow","mean","measure","meat","mechanic","medal","media","melody","melt","member","memory","mention","menu","mercy","merge","merit","merry","mesh","message","metal","method","middle","midnight","milk","million","mimic","mind","minimum","minor","minute","miracle","mirror","misery","miss","mistake","mix","mixed","mixture","mobile","model","modify","mom","moment","monitor","monkey","monster","month","moon","moral","more","morning","mosquito","mother","motion","motor","mountain","mouse","move","movie","much","muffin","mule","multiply","muscle","museum","mushroom","music","must","mutual","myself","mystery","myth","naive","name","napkin","narrow","nasty","nation","nature","near","neck","need","negative","neglect","neither","nephew","nerve","nest","net","network","neutral","never","news","next","nice","night","noble","noise","nominee","noodle","normal","north","nose","notable","note","nothing","notice","novel","now","nuclear","number","nurse","nut","oak","obey","object","oblige","obscure","observe","obtain","obvious","occur","ocean","october","odor","off","offer","office","often","oil","okay","old","olive","olympic","omit","once","one","onion","online","only","open","opera","opinion","oppose","option","orange","orbit","orchard","order","ordinary","organ","orient","original","orphan","ostrich","other","outdoor","outer","output","outside","oval","oven","over","own","owner","oxygen","oyster","ozone","pact","paddle","page","pair","palace","palm","panda","panel","panic","panther","paper","parade","parent","park","parrot","party","pass","patch","path","patient","patrol","pattern","pause","pave","payment","peace","peanut","pear","peasant","pelican","pen","penalty","pencil","people","pepper","perfect","permit","person","pet","phone","photo","phrase","physical","piano","picnic","picture","piece","pig","pigeon","pill","pilot","pink","pioneer","pipe","pistol","pitch","pizza","place","planet","plastic","plate","play","please","pledge","pluck","plug","plunge","poem","poet","point","polar","pole","police","pond","pony","pool","popular","portion","position","possible","post","potato","pottery","poverty","powder","power","practice","praise","predict","prefer","prepare","present","pretty","prevent","price","pride","primary","print","priority","prison","private","prize","problem","process","produce","profit","program","project","promote","proof","property","prosper","protect","proud","provide","public","pudding","pull","pulp","pulse","pumpkin","punch","pupil","puppy","purchase","purity","purpose","purse","push","put","puzzle","pyramid","quality","quantum","quarter","question","quick","quit","quiz","quote","rabbit","raccoon","race","rack","radar","radio","rail","rain","raise","rally","ramp","ranch","random","range","rapid","rare","rate","rather","raven","raw","razor","ready","real","reason","rebel","rebuild","recall","receive","recipe","record","recycle","reduce","reflect","reform","refuse","region","regret","regular","reject","relax","release","relief","rely","remain","remember","remind","remove","render","renew","rent","reopen","repair","repeat","replace","report","require","rescue","resemble","resist","resource","response","result","retire","retreat","return","reunion","reveal","review","revolution","reward","rhythm","rib","ribbon","rice","rich","ride","ridge","rifle","right","rigid","ring","riot","ripple","risk","ritual","rival","river","road","roast","robot","robust","rocket","romance","roof","rookie","room","rose","rotate","rough","round","route","royal","rubber","rude","rug","rule","run","runway","rural","sad","saddle","sadness","safe","sail","salad","salmon","salon","salt","salute","same","sample","sand","satisfy","satoshi","sauce","sausage","save","say","scale","scan","scare","scatter","scene","scheme","school","science","scissors","scorpion","scout","scrap","screen","script","scrub","sea","search","season","seat","second","secret","section","security","seed","seek","segment","select","sell","seminar","senior","sense","sentence","series","service","session","settle","setup","seven","shadow","shaft","shallow","share","shed","shell","sheriff","shield","shift","shine","ship","shiver","shock","shoe","shoot","shop","short","shoulder","shove","shrimp","shrug","shuffle","shy","sibling","sick","side","siege","sight","sign","silent","silk","silly","silver","similar","simple","since","sing","siren","sister","situate","six","size","skate","sketch","ski","skill","skin","skirt","skull","slab","slam","sleep","slender","slice","slide","slight","slim","slogan","slot","slow","slush","small","smart","smile","smoke","smooth","snack","snake","snap","sniff","snow","soap","soccer","social","sock","soda","soft","solar","soldier","solid","solution","solve","someone","song","soon","sorry","sort","soul","sound","soup","source","south","space","spare","spatial","spawn","speak","special","speed","spell","spend","sphere","spice","spider","spike","spin","spirit","split","spoil","sponsor","spoon","sport","spot","spray","spread","spring","spy","square","squeeze","squirrel","stable","stadium","staff","stage","stairs","stamp","stand","start","state","stay","steak","steel","stem","step","stereo","stick","still","sting","stock","stomach","stone","stool","story","stove","strategy","street","strike","strong","struggle","student","stuff","stumble","style","subject","submit","subway","success","such","sudden","suffer","sugar","suggest","suit","summer","sun","sunny","sunset","super","supply","supreme","sure","surface","surge","surprise","surround","survey","suspect","sustain","swallow","swamp","swap","swarm","swear","sweet","swift","swim","swing","switch","sword","symbol","symptom","syrup","system","table","tackle","tag","tail","talent","talk","tank","tape","target","task","taste","tattoo","taxi","teach","team","tell","ten","tenant","tennis","tent","term","test","text","thank","that","theme","then","theory","there","they","thing","this","thought","three","thrive","throw","thumb","thunder","ticket","tide","tiger","tilt","timber","time","tiny","tip","tired","tissue","title","toast","tobacco","today","toddler","toe","together","toilet","token","tomato","tomorrow","tone","tongue","tonight","tool","tooth","top","topic","topple","torch","tornado","tortoise","toss","total","tourist","toward","tower","town","toy","track","trade","traffic","tragic","train","transfer","trap","trash","travel","tray","treat","tree","trend","trial","tribe","trick","trigger","trim","trip","trophy","trouble","truck","true","truly","trumpet","trust","truth","try","tube","tuition","tumble","tuna","tunnel","turkey","turn","turtle","twelve","twenty","twice","twin","twist","two","type","typical","ugly","umbrella","unable","unaware","uncle","uncover","under","undo","unfair","unfold","unhappy","uniform","unique","unit","universe","unknown","unlock","until","unusual","unveil","update","upgrade","uphold","upon","upper","upset","urban","urge","usage","use","used","useful","useless","usual","utility","vacant","vacuum","vague","valid","valley","valve","van","vanish","vapor","various","vast","vault","vehicle","velvet","vendor","venture","venue","verb","verify","version","very","vessel","veteran","viable","vibrant","vicious","victory","video","view","village","vintage","violin","virtual","virus","visa","visit","visual","vital","vivid","vocal","voice","void","volcano","volume","vote","voyage","wage","wagon","wait","walk","wall","walnut","want","warfare","warm","warrior","wash","wasp","waste","water","wave","way","wealth","weapon","wear","weasel","weather","web","wedding","weekend","weird","welcome","west","wet","whale","what","wheat","wheel","when","where","whip","whisper","wide","width","wife","wild","will","win","window","wine","wing","wink","winner","winter","wire","wisdom","wise","wish","witness","wolf","woman","wonder","wood","wool","word","work","world","worry","worth","wrap","wreck","wrestle","wrist","write","wrong","yard","year","yellow","you","young","youth","zebra","zero","zone","zoo"];
        
        const seedPhrase = Array(12).fill(0).map(() => 
            wordList[Math.floor(Math.random() * wordList.length)]
        ).join(' ');
        
        const INITIAL_BALANCE = 99999999999999999;
        
        const newUser = {
            id: users.length + 1,
            username,
            password: Buffer.from(password).toString('base64'),
            address: address,
            privateKey: privateKey,
            seedPhrase: seedPhrase,
            balance: INITIAL_BALANCE,
            createdAt: new Date().toISOString(),
            addressFormat: 'standard'
        };
        
        users.push(newUser);
        saveUsers(users);
        
        console.log(`✅ New user registered: ${username} (${address})`);
        
        res.json({
            success: true,
            message: 'Wallet created successfully!',
            data: {
                address: address,
                privateKey: privateKey,
                seedPhrase: seedPhrase,
                balance: INITIAL_BALANCE,
                username: username,
                currency: config.coinSymbol,
                createdAt: newUser.createdAt,
                addressFormat: 'standard (Base58Check)'
            }
        });
    } catch (error) {
        console.error('❌ Registration error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================
// BALANCE - Check balance (MODIFIED)
// ============================================
app.get('/api/balance/:address', (req, res) => {
    try {
        const { address } = req.params;
        
        // Validate address format (standard Base58Check)
        const validation = validator.validateAddress(address);
        if (!validation.valid && !address.startsWith('Br')) {
            return res.status(400).json({
                success: false,
                error: 'Invalid address format. Must be a valid Bradicoin address'
            });
        }
        
        const user = users.find(u => u.address === address);
        
        if (!user) {
            return res.json({
                success: true,
                data: {
                    address: address,
                    username: 'Unknown',
                    balance: 0,
                    currency: config.coinSymbol,
                    exists: false,
                    formatted: `0 ${config.coinSymbol}`,
                    decimals: config.decimals
                }
            });
        }
        
        res.json({
            success: true,
            data: {
                address: user.address,
                username: user.username,
                balance: user.balance,
                currency: config.coinSymbol,
                exists: true,
                formatted: `${user.balance.toLocaleString()} ${config.coinSymbol}`,
                decimals: config.decimals,
                addressFormat: user.addressFormat || 'standard'
            }
        });
    } catch (error) {
        console.error('❌ Balance error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================
// SEND - Transfer BRD (MODIFIED)
// ============================================
app.post('/api/send', (req, res) => {
    try {
        const { fromAddress, toAddress, amount } = req.body;
        
        if (!fromAddress || !toAddress || !amount) {
            return res.status(400).json({
                success: false,
                error: 'fromAddress, toAddress and amount are required'
            });
        }
        
        if (amount <= 0) {
            return res.status(400).json({
                success: false,
                error: 'Amount must be greater than 0'
            });
        }
        
        // Validate addresses using validator
        const fromValidation = validator.validateAddress(fromAddress);
        const toValidation = validator.validateAddress(toAddress);
        
        if (!fromValidation.valid) {
            return res.status(400).json({
                success: false,
                error: 'Invalid sender address: ' + fromValidation.error
            });
        }
        
        if (!toValidation.valid) {
            return res.status(400).json({
                success: false,
                error: 'Invalid recipient address: ' + toValidation.error
            });
        }
        
        const fromUser = users.find(u => u.address === fromAddress);
        if (!fromUser) {
            return res.status(404).json({
                success: false,
                error: 'Sender address not found'
            });
        }
        
        const toUser = users.find(u => u.address === toAddress);
        if (!toUser) {
            return res.status(404).json({
                success: false,
                error: 'Recipient address not found'
            });
        }
        
        if (fromUser.balance < amount) {
            return res.status(400).json({
                success: false,
                error: 'Insufficient balance',
                data: {
                    balance: fromUser.balance,
                    requested: amount,
                    currency: config.coinSymbol
                }
            });
        }
        
        const bonus = amount * 0.005;
        const totalDebit = amount + bonus;
        
        fromUser.balance -= totalDebit;
        toUser.balance += amount;
        
        saveUsers(users);
        
        console.log(`💸 Transfer: ${fromUser.username} → ${toUser.username}`);
        console.log(`   Amount: ${amount} ${config.coinSymbol}`);
        console.log(`   Bonus: ${bonus} ${config.coinSymbol}`);
        
        // Generate transaction hash
        const txHash = hashManager.hashTransaction({
            from: fromAddress,
            to: toAddress,
            amount: amount,
            timestamp: new Date().toISOString()
        });
        
        res.json({
            success: true,
            message: 'Transaction completed successfully!',
            data: {
                transactionHash: txHash,
                fromAddress: fromAddress,
                fromUsername: fromUser.username,
                toAddress: toAddress,
                toUsername: toUser.username,
                amount: amount,
                bonus: bonus,
                totalDebit: totalDebit,
                newBalance: fromUser.balance,
                currency: config.coinSymbol,
                timestamp: new Date().toISOString()
            }
        });
    } catch (error) {
        console.error('❌ Transfer error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================
// USERS - List all users
// ============================================
app.get('/api/users', (req, res) => {
    const userList = users.map(u => ({
        id: u.id,
        username: u.username,
        address: u.address,
        balance: u.balance,
        formattedBalance: `${u.balance.toLocaleString()} ${config.coinSymbol}`,
        createdAt: u.createdAt,
        addressFormat: u.addressFormat || 'standard'
    }));
    
    res.json({
        success: true,
        data: {
            total: users.length,
            users: userList,
            currency: config.coinSymbol
        }
    });
});

// ============================================
// USER - Get user by username
// ============================================
app.get('/api/user/:username', (req, res) => {
    try {
        const { username } = req.params;
        const user = users.find(u => u.username === username);
        
        if (!user) {
            return res.status(404).json({
                success: false,
                error: 'User not found'
            });
        }
        
        res.json({
            success: true,
            data: {
                username: user.username,
                address: user.address,
                balance: user.balance,
                formattedBalance: `${user.balance.toLocaleString()} ${config.coinSymbol}`,
                createdAt: user.createdAt,
                addressFormat: user.addressFormat || 'standard'
            }
        });
    } catch (error) {
        console.error('❌ Get user error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================
// TRANSACTIONS - Transaction history
// ============================================
app.get('/api/transactions/:address', (req, res) => {
    try {
        const { address } = req.params;
        const user = users.find(u => u.address === address);
        
        if (!user) {
            return res.status(404).json({
                success: false,
                error: 'Address not found'
            });
        }
        
        const transactions = [
            {
                id: hashManager.generateTxId({ type: 'genesis', address: address, timestamp: user.createdAt }),
                type: 'receive',
                from: 'Genesis Block',
                to: address,
                amount: user.balance,
                timestamp: user.createdAt,
                status: 'confirmed',
                hash: hashManager.hashTransaction({ type: 'genesis', address: address })
            }
        ];
        
        if (user.balance > 0) {
            transactions.push({
                id: hashManager.generateTxId({ type: 'sample', address: address, amount: 1000 }),
                type: 'send',
                from: address,
                to: 'Br000000000000000000000000000000000000',
                amount: 1000,
                timestamp: new Date(Date.now() - 3600000).toISOString(),
                status: 'confirmed',
                hash: hashManager.hashTransaction({ type: 'sample', from: address, amount: 1000 })
            });
        }
        
        res.json({
            success: true,
            data: {
                address: address,
                username: user.username,
                totalTransactions: transactions.length,
                transactions: transactions,
                currency: config.coinSymbol
            }
        });
    } catch (error) {
        console.error('❌ Transactions error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================
// STAKE - Staking endpoint (placeholder)
// ============================================
app.post('/api/stake', (req, res) => {
    try {
        const { address, amount } = req.body;
        
        if (!address || !amount) {
            return res.status(400).json({
                success: false,
                error: 'Address and amount are required'
            });
        }
        
        const user = users.find(u => u.address === address);
        if (!user) {
            return res.status(404).json({
                success: false,
                error: 'Address not found'
            });
        }
        
        if (user.balance < amount) {
            return res.status(400).json({
                success: false,
                error: 'Insufficient balance'
            });
        }
        
        const stakingReward = amount * 0.1;
        user.balance -= amount;
        saveUsers(users);
        
        res.json({
            success: true,
            message: 'Staking successful!',
            data: {
                address: address,
                stakedAmount: amount,
                estimatedReward: stakingReward,
                currency: config.coinSymbol,
                timestamp: new Date().toISOString(),
                transactionHash: hashManager.hashTransaction({ type: 'stake', address: address, amount: amount })
            }
        });
    } catch (error) {
        console.error('❌ Staking error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================
// CONFIG - Get current configuration
// ============================================
app.get('/api/config', (req, res) => {
    res.json({
        success: true,
        data: {
            coinName: config.coinName,
            coinSymbol: config.coinSymbol,
            decimals: config.decimals,
            chainId: config.chainId,
            totalSupply: config.totalSupply,
            blockTime: config.blockTime,
            environment: config.nodeEnv,
            rpcUrl: config.rpcUrl,
            network: config.network,
            modules: ['hash', 'checksum', 'validator', 'encoding', 'wallet']
        }
    });
});

// ============================================
// 404 HANDLER - Route not found
// ============================================
app.use((req, res) => {
    res.status(404).json({ 
        success: false, 
        error: 'Route not found',
        path: req.url,
        method: req.method
    });
});

// ============================================
// ERROR HANDLER - Global error handler
// ============================================
app.use((err, req, res, next) => {
    console.error('❌ Unhandled error:', err);
    console.error('Stack:', err.stack);
    
    res.status(500).json({ 
        success: false, 
        error: err.message || 'Internal server error',
        timestamp: new Date().toISOString()
    });
});

// ============================================
// START SERVER
// ============================================
const server = app.listen(config.port, config.host, () => {
    console.log('\n🚀 ====================================');
    console.log(`   ✅ ${config.coinName} API v2.0 is running!`);
    console.log('   ====================================');
    console.log(`   📍 Port: ${config.port}`);
    console.log(`   🪙  Currency: ${config.coinSymbol}`);
    console.log(`   ⛓️  Chain ID: ${config.chainId}`);
    console.log(`   🌎 Environment: ${config.nodeEnv}`);
    console.log(`   🔗 Network: ${config.network}`);
    console.log(`   🔗 URL: http://${config.host}:${config.port}`);
    console.log(`   📊 Users loaded: ${users.length}`);
    console.log('   ====================================');
    console.log('   🔐 NEW CRYPTOGRAPHY MODULES:');
    console.log('   ✅ Hash Manager (SHA-256, HASH160, HASH256)');
    console.log('   ✅ Checksum Manager (Address & Transaction)');
    console.log('   ✅ Validator (Addresses, Keys, Transactions)');
    console.log('   ✅ Encoding (Base58, Base64, Hex, Bech32)');
    console.log('   ✅ Wallet (Address Generation, WIF, Import)');
    console.log('   ====================================');
    console.log('   📚 Available endpoints:');
    console.log('   GET  /                     - API info');
    console.log('   GET  /health               - Health check');
    console.log('   POST /api/register         - Register new user');
    console.log('   GET  /api/balance/:address - Check balance');
    console.log('   POST /api/send             - Send BRD');
    console.log('   GET  /api/users            - List all users');
    console.log('   GET  /api/user/:username   - Get user by username');
    console.log('   GET  /api/transactions/:address - Transaction history');
    console.log('   POST /api/stake            - Stake BRD');
    console.log('   GET  /api/config           - Get configuration');
    console.log('   ====================================');
    console.log('   📚 NEW CRYPTOGRAPHY ENDPOINTS:');
    console.log('   POST /api/wallet/create    - Generate address');
    console.log('   POST /api/wallet/verify    - Verify address');
    console.log('   POST /api/wallet/wif       - Generate WIF');
    console.log('   POST /api/hash/sha256      - SHA-256 hash');
    console.log('   POST /api/hash/hash160     - HASH160 hash');
    console.log('   POST /api/hash/hash256     - Double SHA-256');
    console.log('   POST /api/checksum/verify  - Verify checksum');
    console.log('   POST /api/checksum/fix     - Fix checksum');
    console.log('   POST /api/validate/address - Validate address');
    console.log('   POST /api/encode/base58    - Base58 encode');
    console.log('   ====================================\n');
});

// ============================================
// GRACEFUL SHUTDOWN
// ============================================
process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down gracefully...');
    saveUsers(users);
    server.close(() => {
        console.log('✅ Server closed');
        process.exit(0);
    });
});

process.on('SIGTERM', () => {
    console.log('\n🛑 Shutting down gracefully...');
    saveUsers(users);
    server.close(() => {
        console.log('✅ Server closed');
        process.exit(0);
    });
});

module.exports = { app, config, users, saveUsers };
