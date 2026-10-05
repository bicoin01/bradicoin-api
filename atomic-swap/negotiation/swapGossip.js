// atomic-swap/negotiation/swapGossip.js
// ============================================
// SwapGossip — Camada P2P pra negociação
// ============================================
// Integra com o p2p/Random Walk existente.
// Propaga mensagens de ordens entre peers.
// ============================================

const { EventEmitter } = require('events');
const msg = require('./orderMessage');
const orderBook = require('./orderBook');

const DEDUP_TTL_MS = 5 * 60 * 1000;    // 5 min
const GOSSIP_FANOUT = 8;                // envia pra até 8 peers

class SwapGossip extends EventEmitter {
    constructor({ node, peerId, privateKey, publicKey }) {
        super();
        this.node = node;
        this.peerId = peerId;
        this.privateKey = privateKey;
        this.publicKey = publicKey;

        // Anti-loop: mensagens já vistas
        this.seenMessages = new Map();  // msgId → timestamp

        // Estatísticas
        this.stats = {
            sent: 0,
            received: 0,
            relayed: 0,
            dropped: 0
        };

        this._cleanupInterval = null;
        this._initialized = false;
    }

    // ============================================
    // INICIALIZAÇÃO
    // ============================================
    async initialize() {
        if (this._initialized) return;

        if (!this.node) {
            console.warn('⚠️  SwapGossip: node P2P não fornecido');
            return;
        }

        // Registra handler no P2P pra mensagens de swap
        this._registerP2PHandler();

        // Inicia cleanup
        this._cleanupInterval = setInterval(() => this._cleanup(), 60_000);

        this._initialized = true;
        console.log('📡 SwapGossip inicializado');
    }

    _registerP2PHandler() {
        // Assumindo que p2p expõe um EventEmitter com 'message'
        this.node.on('message', async ({ from, data, topic }) => {
            if (topic !== 'atomic-swap') return;
            await this._handleIncoming(data, from);
        });
    }

    // ============================================
    // PUBLICAR MENSAGEM
    // ============================================
    async publish(type, payload, { ttl = 5 } = {}) {
        const message = msg.createMessage(type, payload, {
            sender: this.peerId,
            ttl,
            privateKey: this.privateKey,
            publicKey: this.publicKey
        });

        // Marca como vista (não reprocessa)
        this.seenMessages.set(message.id, Date.now());

        await this._broadcast(message);
        this.stats.sent++;

        return message;
    }

    async announceOrder(order) {
        return this.publish(msg.MESSAGE_TYPES.ORDER_ANNOUNCE, {
            swapId: order.swapId,
            maker: order.maker,
            taker: order.taker,
            fromChain: order.fromChain,
            toChain: order.toChain,
            fromToken: order.fromToken,
            toToken: order.toToken,
            rate: order.rate,
            hashlock: order.hashlock,
            timelockMaker: order.timelockMaker,
            timelockTaker: order.timelockTaker,
            expiresAt: order.expiresAt
        });
    }

    async cancelOrder(swapId, makerAddress) {
        return this.publish(msg.MESSAGE_TYPES.ORDER_CANCEL, {
            swapId,
            makerAddress,
            cancelledAt: Date.now()
        });
    }

    async requestOrders({ fromChain, toChain, fromToken, toToken, maxResults = 20 }) {
        return this.publish(msg.MESSAGE_TYPES.ORDER_REQUEST, {
            fromChain,
            toChain,
            fromToken,
            toToken,
            maxResults
        });
    }

    async proposeTrade({ swapId, takerAddress }) {
        return this.publish(msg.MESSAGE_TYPES.TRADE_PROPOSE, {
            swapId,
            takerAddress,
            takerPeerId: this.peerId,
            proposedAt: Date.now()
        });
    }

    // ============================================
    // RECEBER MENSAGEM
    // ============================================
    async _handleIncoming(rawData, fromPeer) {
        this.stats.received++;

        const message = msg.deserializeMessage(rawData);
        if (!message) {
            this.stats.dropped++;
            return;
        }

        // Já vi?
        if (this.seenMessages.has(message.id)) {
            this.stats.dropped++;
            return;
        }

        // Valida
        const validation = msg.validateMessage(message);
        if (!validation.ok) {
            console.warn(`⚠️  Mensagem inválida: ${validation.reason}`);
            this.stats.dropped++;
            return;
        }

        // Marca como vista
        this.seenMessages.set(message.id, Date.now());

        // Processa localmente
        await this._processMessage(message, fromPeer);

        // Relay (com TTL-1)
        if (message.ttl > 1) {
            const relayed = msg.decrementTtl(message);
            await this._broadcast(relayed, fromPeer);
            this.stats.relayed++;
        }

        this.emit('message', { message, fromPeer });
    }

    // ============================================
    // PROCESSAR POR TIPO
    // ============================================
    async _processMessage(message, fromPeer) {
        switch (message.type) {
            case msg.MESSAGE_TYPES.ORDER_ANNOUNCE:
                await this._onOrderAnnounce(message.payload, fromPeer);
                break;

            case msg.MESSAGE_TYPES.ORDER_CANCEL:
                await this._onOrderCancel(message.payload);
                break;

            case msg.MESSAGE_TYPES.ORDER_REQUEST:
                await this._onOrderRequest(message.payload, fromPeer, message.sender);
                break;

            case msg.MESSAGE_TYPES.ORDER_RESPONSE:
                await this._onOrderResponse(message.payload);
                break;

            case msg.MESSAGE_TYPES.TRADE_PROPOSE:
                await this._onTradePropose(message.payload, fromPeer);
                break;

            case msg.MESSAGE_TYPES.TRADE_ACCEPT:
                await this._onTradeAccept(message.payload);
                break;

            case msg.MESSAGE_TYPES.TRADE_REJECT:
                await this._onTradeReject(message.payload);
                break;

            default:
                break;
        }
    }

    // ============================================
    // HANDLERS
    // ============================================
    async _onOrderAnnounce(payload, fromPeer) {
        orderBook.addOrder(payload);
        console.log(`📥 Ordem recebida: ${payload.swapId} (${payload.fromToken}→${payload.toToken}) de ${fromPeer}`);
        this.emit('order:announced', payload);
    }

    async _onOrderCancel(payload) {
        orderBook.removeOrder(payload.swapId);
        console.log(`🗑️  Ordem cancelada: ${payload.swapId}`);
        this.emit('order:cancelled', payload);
    }

    async _onOrderRequest(payload, fromPeer, senderPeerId) {
        const orders = orderBook.findOrders({
            fromChain: payload.fromChain,
            fromToken: payload.fromToken,
            toChain: payload.toChain,
            toToken: payload.toToken,
            maxResults: payload.maxResults
        });

        // Responde direto pro peer que pediu
        if (senderPeerId) {
            const response = msg.createMessage(
                msg.MESSAGE_TYPES.ORDER_RESPONSE,
                { orders, count: orders.length },
                {
                    sender: this.peerId,
                    ttl: 1,
                    privateKey: this.privateKey,
                    publicKey: this.publicKey
                }
            );

            await this._sendToPeer(senderPeerId, response);
            console.log(`📤 Respondendo ${orders.length} ordens pra ${senderPeerId}`);
        }
    }

    async _onOrderResponse(payload) {
        for (const order of payload.orders || []) {
            orderBook.addOrder(order);
        }
        this.emit('orders:received', payload.orders);
    }

    async _onTradePropose(payload, fromPeer) {
        console.log(`🤝 Trade proposto: ${payload.swapId} por ${payload.takerAddress}`);
        this.emit('trade:proposed', { ...payload, fromPeer });
    }

    async _onTradeAccept(payload) {
        console.log(`✅ Trade aceito: ${payload.swapId}`);
        this.emit('trade:accepted', payload);
    }

    async _onTradeReject(payload) {
        console.log(`❌ Trade rejeitado: ${payload.swapId} (${payload.reason})`);
        this.emit('trade:rejected', payload);
    }

    // ============================================
    // BROADCAST
    // ============================================
    async _broadcast(message, excludePeer = null) {
        if (!this.node || !this.node.peers) return;

        const peers = Array.from(this.node.peers.keys())
            .filter(p => p !== excludePeer)
            .slice(0, GOSSIP_FANOUT);

        const serialized = msg.serializeMessage(message);

        await Promise.all(peers.map(async (peerId) => {
            try {
                await this._sendToPeer(peerId, serialized);
            } catch (e) {
                console.warn(`Erro ao enviar pra ${peerId}:`, e.message);
            }
        }));
    }

    async _sendToPeer(peerId, payload) {
        if (!this.node || !this.node.send) {
            // Fallback pra biblioteca P2P
            if (this.node && this.node.libp2p) {
                const stream = await this.node.libp2p.dialProtocol(peerId, '/atomic-swap/1.0.0');
                const data = typeof payload === 'string' ? payload : msg.serializeMessage(payload);
                await stream.sink([Buffer.from(data)]);
            }
            return;
        }
        await this.node.send(peerId, payload, { topic: 'atomic-swap' });
    }

    // ============================================
    // CLEANUP
    // ============================================
    _cleanup() {
        const now = Date.now();
        let removed = 0;

        for (const [id, ts] of this.seenMessages.entries()) {
            if (now - ts > DEDUP_TTL_MS) {
                this.seenMessages.delete(id);
                removed++;
            }
        }

        if (removed > 0 && process.env.DEBUG) {
            console.log(`🧹 SwapGossip: ${removed} mensagens limpas`);
        }
    }

    getStats() {
        return {
            ...this.stats,
            seenMessages: this.seenMessages.size,
            connectedPeers: this.node?.peers?.size || 0
        };
    }

    stop() {
        if (this._cleanupInterval) {
            clearInterval(this._cleanupInterval);
            this._cleanupInterval = null;
        }
        console.log('📡 SwapGossip parado');
    }
}

module.exports = SwapGossip;
