// p2p/node.js
// ============================================
// Bradicoin P2P — Host libp2p (Fase A)
// ============================================
// Sobe o host libp2p com transporte, segurança, mux e identify/ping.
// NÃO conhece blockchain, NÃO conhece gossip.
// Só existe pra dar identidade e transporte ao nó.
// ============================================

const { createLibp2p } = require('libp2p');
const { tcp } = require('@libp2p/tcp');
const { webSockets } = require('@libp2p/websockets');
const { noise } = require('@chainsafe/libp2p-noise');
const { yamux } = require('@chainsafe/libp2p-yamux');
const { identify } = require('@libp2p/identify');
const { ping } = require('@libp2p/ping');
const { loadOrCreateIdentity } = require('./identity');

const DEFAULT_P2P_PORT = parseInt(process.env.P2P_PORT) || 4001;
const AGENT_VERSION = `bradicoin/4.0.0`;

async function createP2PNode() {
  const { privateKey, peerId } = await loadOrCreateIdentity();

  const node = await createLibp2p({
    privateKey,
    addresses: {
      listen: [
        `/ip4/0.0.0.0/tcp/${DEFAULT_P2P_PORT}`,
        `/ip4/0.0.0.0/tcp/${DEFAULT_P2P_PORT + 1}/ws`,
      ],
    },
    transports: [tcp(), webSockets()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    connectionManager: {
      maxConnections: 64,
      minConnections: 0,
    },
    services: {
      identify: identify({ agentVersion: AGENT_VERSION }),
      ping: ping(),
    },
  });

  node.addEventListener('peer:connect', (evt) => {
    console.log(`🔗 Peer conectado: ${evt.detail.toString()}`);
  });

  node.addEventListener('peer:disconnect', (evt) => {
    console.log(`🔌 Peer desconectado: ${evt.detail.toString()}`);
  });

  await node.start();

  console.log(`🌐 P2P node iniciado`);
  console.log(`   PeerID: ${peerId.toString()}`);
  console.log(`   Escutando em:`);
  for (const addr of node.getMultiaddrs()) {
    console.log(`     ${addr.toString()}`);
  }

  return node;
}

async function dialPeer(node, multiaddrStr) {
  const { multiaddr } = require('@multiformats/multiaddr');
  try {
    const ma = multiaddr(multiaddrStr);
    const conn = await node.dial(ma);
    console.log(`✅ Dial OK: ${conn.remotePeer.toString()}`);
    return conn;
  } catch (err) {
    console.error(`❌ Dial falhou (${multiaddrStr}):`, err.message);
    return null;
  }
}

async function stopP2PNode(node) {
  if (!node) return;
  console.log('🛑 Parando P2P node...');
  await node.stop();
  console.log('✅ P2P node parado');
}

module.exports = {
  createP2PNode,
  dialPeer,
  stopP2PNode,
  DEFAULT_P2P_PORT,
  AGENT_VERSION,
};
