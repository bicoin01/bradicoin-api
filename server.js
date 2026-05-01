const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

console.log('🚀 Starting Bradicoin API...');

// Banco de dados em memória
const usuarios = [];

// Rota principal
app.get('/', (req, res) => {
    res.json({
        name: 'Bradicoin API',
        version: '1.0.0',
        status: 'online',
        currency: 'BRD',
        message: 'API funcionando perfeitamente!'
    });
});

// Health check
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        currency: 'BRD',
        message: 'API is healthy'
    });
});

// Registrar usuário
app.post('/api/register', (req, res) => {
    try {
        const { username, password } = req.body;
        
        if (!username || !password) {
            return res.status(400).json({ 
                success: false, 
                error: 'Username and password are required' 
            });
        }
        
        if (usuarios.length >= 3) {
            return res.status(403).json({ 
                success: false, 
                error: 'Maximum 3 users allowed' 
            });
        }
        
        const usuarioExistente = usuarios.find(u => u.username === username);
        if (usuarioExistente) {
            return res.status(400).json({ 
                success: false, 
                error: 'Username already exists' 
            });
        }
        
        const endereco = `Br${Date.now().toString(36)}${Math.random().toString(36).substring(2, 10)}`;
        const seedPhrase = Array(12).fill(0).map(() => {
            const palavras = ["abandon","ability","able","about","above","absent","absorb","abstract","absurd","abuse","access","accident","account","accuse","achieve","acid","acoustic","acquire","across","act","action","actor","actress","actual","adapt","add","addict","address","adjust","admit","adult","advance","advice"];
            return palavras[Math.floor(Math.random() * palavras.length)];
        }).join(' ');
        
        const RESERVA = 99999999999999999;
        
        usuarios.push({
            id: usuarios.length + 1,
            username,
            password,
            endereco,
            seedPhrase,
            saldo: RESERVA,
            criadoEm: new Date().toISOString()
        });
        
        res.json({
            success: true,
            message: 'Wallet created successfully!',
            data: {
                address: endereco,
                seedPhrase: seedPhrase,
                balance: RESERVA,
                username: username
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Consultar saldo
app.get('/api/balance/:address', (req, res) => {
    try {
        const { address } = req.params;
        const usuario = usuarios.find(u => u.endereco === address);
        
        if (!usuario) {
            // Para teste, retorna saldo padrão
            return res.json({
                success: true,
                data: {
                    address: address,
                    balance: 99999999999999999,
                    currency: 'BRD'
                }
            });
        }
        
        res.json({
            success: true,
            data: {
                address: usuario.endereco,
                balance: usuario.saldo,
                currency: 'BRD'
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Enviar BRD
app.post('/api/send', (req, res) => {
    try {
        const { fromAddress, toAddress, amount } = req.body;
        
        res.json({
            success: true,
            message: `Transaction completed!`,
            data: {
                fromAddress: fromAddress,
                toAddress: toAddress,
                amount: amount,
                bonus: amount * 0.005,
                newBalance: 99999999999999999
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Listar todos os usuários
app.get('/api/users', (req, res) => {
    res.json({
        success: true,
        data: {
            total: usuarios.length,
            max: 3,
            users: usuarios.map(u => ({ username: u.username, address: u.endereco }))
        }
    });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({ 
        success: false, 
        error: 'Route not found',
        path: req.url 
    });
});

// Error handler
app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
});

// Iniciar servidor
app.listen(PORT, () => {
    console.log(`✅ Bradicoin API is running!`);
    console.log(`📍 Port: ${PORT}`);
    console.log(`💰 Currency: BRD`);
    console.log(`🔗 URL: http://localhost:${PORT}`);
});
