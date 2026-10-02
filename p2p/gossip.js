// p2p/gossip.js
// Broadcast eficiente: envia para N peers com melhor score, sem repetir.

const DEFAULT_FANOUT = 8;

function broadcast(ctx, rawMessage, { except = null, fanout = DEFAULT_FANOUT } = {}) {
  const { peerManager, peers } = ctx; // peers = mapa addr->conexão ativa
  if (!peers || peers.size === 0) return;

  const candidates = peerManager.bestPeers(fanout * 2)
    .filter(p => !except || p.addr !== except.addr);

  let sent = 0;
  for (const p of candidates) {
    if (sent >= fanout) break;
    const conn = peers.get(p.addr);
    if (conn && conn.readyState === 'open') {
      conn.send(rawMessage);
      sent++;
    }
  }
}

module.exports = { broadcast };
