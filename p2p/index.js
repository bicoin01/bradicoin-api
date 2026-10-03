// p2p/index.js
// ============================================
// Bradicoin P2P — orquestrador (CJS + dynamic ESM)
// ============================================
// ⚠️ libp2p moderno (v2/v3) é ESM puro. Como o projeto é CJS,
//    carregamos via import() dinâmico dentro de loadLibp2p().
// ============================================

let createLibp2p, tcp, webSockets, noise, yamux, identify, ping;
let _libp2pLoaded = false;

async function loadLibp2p() {
  if (_libp2pLoaded) return;

  const [
    libp2pMod,
    tcpMod,
    wsMod,
    noiseMod,
    yamuxMod,
    identifyMod,
    pingMod,
  ] = await Promise.all([
    import('libp2p'),
    import('@libp2p/tcp'),
    import('@libp2p/websockets'),
    import('@chainsafe/libp2p-noise'),
    import('@chainsafe/libp2p-yamux'),
    import('@libp2p/identify'),
    import('@libp2p/ping'),
  ]);

  createLibp2p = libp2pMod.createLibp2p;
  tcp          = tcpMod.tcp;
  webSockets   = wsMod.webSockets;
  noise        = noiseMod.noise;
  yamux        = yamuxMod.yamux;
  identify     = identifyMod.identify;
  ping         = pingMod.ping;

  _libp2pLoaded = true;
}

// ── Módulos internos (CJS puro, sem problema) ────────────
const { loadOrCreateIdentity } = require('./identity');
const { registerStatusProtocol, queryStatus } = require('./status');
const { buildGossipService, wireGossip } = require('./gossip');
const { registerIBDProtocol, runIBD } = require('./ibd');
const { buildDiscoveryServices } = require('./discovery');
const scoring = require('./scoring');

const DEFAULT_PORT = parseInt(process.env.P2P_PORT) || 4001;

async function startP2P({ blockchain, port = DEFAULT_PORT } = {}) {
  if (!blockchain) throw new Error('blockchain obrigatório');

  // ⚠️ Carrega libp2p (ESM) antes de qualquer uso
  await loadLibp2p();

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

  // ── PEER:CONNECT ───────────────────────────────────────
  node.addEventListener('peer:connect', async (evt) => {
    const pid = evt.detail;

    // ── LIMITE POR SUBNET ─────────────────────────────
    const ipDiv = require('./ipDiversity');
    let multiaddrStr = null;
    try {
      const conn = node.getConnections(pid)[0];
      multiaddrStr = conn?.remoteAddr?.toString?.() || null;
    } catch {}

    const reg = ipDiv.register(pid, multiaddrStr);
    if (!reg.ok) {
      console.warn(
        `🚫 eclipse-block: ${pid.toString().substring(0, 16)}... ` +
        `(subnet ${reg.subnet} cheia: ${reg.current}/${reg.max})`
      );
      try { await node.hangUp(pid); } catch {}
      return;
    }
    // ──────────────────────────────────────────────────

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

  // ── PEER:DISCONNECT ────────────────────────────────────
  node.addEventListener('peer:disconnect', (evt) => {
    console.log(`🔌 Peer desconectado: ${evt.detail.toString()}`);
    require('./ipDiversity').unregister(evt.detail);
    require('./persistence').markPeersDirty();
  });

  await node.start();

  require('./persistence').setNode(node);

  console.log(`🌐 P2P node iniciado`);
  console.log(`   PeerID: ${peerId.toString()}`);
  for (const addr of node.getMultiaddrs()) console.log(`   ${addr.toString()}`);

  // ── PROTOCOLOS + GOSSIP ────────────────────────────────
  registerStatusProtocol(node, blockchain);
  registerIBDProtocol(node, blockchain);
  await wireGossip(node, blockchain);

  // ── RATE LIMIT + SIZE LIMIT ────────────────────────────
  const rateLimit = require('./rateLimit');
  const msgSize = require('./messageSize');

  node.services.pubsub.addEventListener('message', (evt) => {
    const from = evt.detail.from;
    if (!from) return;

    // 1. Tamanho
    const sizeCheck = msgSize.check(evt.detail.data);
    if (!sizeCheck.ok) {
      scoring.penalize(from, 30, `size-limit:${sizeCheck.reason}`);
      console.warn(
        `⚠️  msg grande demais de ${from.toString().substring(0, 16)}... ` +
        `(${sizeCheck.size} bytes, max ${msgSize.MAX_MESSAGE_BYTES})`
      );
      if (scoring.get(from) < 30) {
        node.hangUp(from).catch(() => {});
      }
      return;
    }

    // 2. Taxa
    if (!rateLimit.allow(from)) {
      scoring.penalize(from, 10, 'rate-limit');
      console.warn(`⚠️  rate limit: ${from.toString().substring(0, 16)}...`);
      if (scoring.get(from) < 30) {
        node.hangUp(from).catch(() => {});
      }
      return;
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
