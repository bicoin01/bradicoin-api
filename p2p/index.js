// p2p/index.js
const { createLibp2p } = require('libp2p');
const { tcp } = require('@libp2p/tcp');
const { webSockets } = require('@libp2p/websockets');
const { noise } = require('@chainsafe/libp2p-noise');
const { yamux } = require('@chainsafe/libp2p-yamux');
const { identify } = require('@libp2p/identify');
const { ping } = require('@libp2p/ping');

const { loadOrCreateIdentity } = require('./identity');
const { registerStatusProtocol, queryStatus } = require('./status');
const { buildGossipService, wireGossip } = require('./gossip');
const { registerIBDProtocol, runIBD } = require('./ibd');
const { buildDiscoveryServices } = require('./discovery');
const scoring = require('./scoring');

const DEFAULT_PORT = parseInt(process.env.P2P_PORT) || 4001;

async function startP2P({ blockchain, port = DEFAULT_PORT } = {}) {
  if (!blockchain) throw new Error('blockchain obrigatório');

  const { privateKey, peerId } = await loadOrCreateIdentity();
  const discovery = buildDiscoveryServices();

  const node = await createLibp2p({
    privateKey,
    addresses: {
      listen: [
        `/ip4/0.0.0.0/tcp/${port}`,
        `/ip4/0.0.0.0/tcp/${port + 1}/ws`,
      ],
    },
    transports: [tcp(), webSockets()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    connectionManager: { maxConnections: 128, minConnections: 0 },
    services: {
      identify: identify({ agentVersion: 'bradicoin/4.0.0' }),
      ping: ping(),
      pubsub: buildGossipService(),
      ...discovery,
    },
  });

  node.addEventListener('peer:connect', async (evt) => {
    const pid = evt.detail;
    console.log(`🔗 Peer conectado: ${pid.toString()}`);
    require('./persistence').markPeersDirty();
    try {
      const st = await queryStatus(node, pid);
      const localLatest = blockchain.getLatestBlock();
      const localH = localLatest ? localLatest.index : -1;
      if (st && st.height > localH + 5) {
        console.log(`🧭 peer à frente (${st.height} > ${localH}), IBD`);
        runIBD(node, blockchain, pid)
          .catch(e => console.error('IBD:', e.message));
      }
    } catch (e) {
      console.error('[status]', e.message);
    }
  });

  node.addEventListener('peer:disconnect', (evt) => {
    console.log(`🔌 Peer desconectado: ${evt.detail.toString()}`);
    require('./persistence').markPeersDirty();
  });

  await node.start();

  require('./persistence').setNode(node);
  
  console.log(`🌐 P2P node iniciado`);
  console.log(`   PeerID: ${peerId.toString()}`);
  for (const addr of node.getMultiaddrs()) console.log(`   ${addr.toString()}`);

  registerStatusProtocol(node, blockchain);
  registerIBDProtocol(node, blockchain);
  await wireGossip(node, blockchain);

  // ── RATE LIMIT ─────────────────────────────────────────
  const rateLimit = require('./rateLimit');
  const scoring = require('./scoring');

  node.services.pubsub.addEventListener('message', (evt) => {
    const from = evt.detail.from;
    if (!from) return;

    if (!rateLimit.allow(from)) {
      scoring.penalize(from, 10, 'rate-limit');
      console.warn(`⚠️  rate limit: ${from.toString().substring(0, 16)}...`);
      if (scoring.get(from) < 30) {
        node.hangUp(from).catch(() => {});
      }
    }
  });
  
  return { node, peerId };
}

async function stopP2P(node) {
  if (!node) return;
  console.log('🛑 Parando P2P...');
  require('./persistence').flushSync();
  await node.stop();
  console.log('✅ P2P parado');
}

module.exports = { startP2P, stopP2P, scoring };
