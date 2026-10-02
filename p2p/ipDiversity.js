// p2p/ipDiversity.js
// Limita o número de peers por IP /24 para evitar eclipse attack.
'use strict';

const MAX_PEERS_PER_SUBNET = 2;   // máx conexões do mesmo /24

// peerId.toString() → { ip, subnet }
const _peerIps = new Map();
// subnet → Set<peerIdString>
const _subnetPeers = new Map();

/**
 * Extrai o IP /24 (classe C) de um multiaddr.
 * Ex: "/ip4/192.168.1.42/tcp/4001" → "192.168.1"
 * Retorna null se não for IPv4 (IPv6 fica sem limite por enquanto).
 */
function extractSubnet(multiaddrStr) {
  if (!multiaddrStr || typeof multiaddrStr !== 'string') return null;
  const m = multiaddrStr.match(/\/ip4\/(\d+\.\d+\.\d+)\.\d+/);
  return m ? m[1] : null;
}

/**
 * Tenta registrar uma conexão para o peer.
 * Retorna { ok: true } se permitido, { ok: false, reason } se recusado.
 */
function register(peerId, multiaddrStr) {
  const key = peerId.toString();
  const subnet = extractSubnet(multiaddrStr);

  // Não é IPv4 → não limita (por enquanto)
  if (!subnet) {
    _peerIps.set(key, { ip: null, subnet: null });
    return { ok: true };
  }

  // Já tem registro? Só atualiza e permite
  if (_peerIps.has(key)) {
    _peerIps.set(key, { ip: multiaddrStr, subnet });
    return { ok: true };
  }

  // Conta quantos peers existem nesse /24
  let set = _subnetPeers.get(subnet);
  if (!set) {
    set = new Set();
    _subnetPeers.set(subnet, set);
  }

  if (set.size >= MAX_PEERS_PER_SUBNET) {
    return {
      ok: false,
      reason: 'subnet-full',
      subnet,
      current: set.size,
      max: MAX_PEERS_PER_SUBNET,
    };
  }

  set.add(key);
  _peerIps.set(key, { ip: multiaddrStr, subnet });
  return { ok: true, subnet };
}

/**
 * Remove o registro quando o peer desconecta.
 */
function unregister(peerId) {
  const key = peerId.toString();
  const entry = _peerIps.get(key);
  if (!entry) return;
  if (entry.subnet) {
    const set = _subnetPeers.get(entry.subnet);
    if (set) {
      set.delete(key);
      if (set.size === 0) _subnetPeers.delete(entry.subnet);
    }
  }
  _peerIps.delete(key);
}

/**
 * Diagnóstico — quantos peers por subnet no momento.
 */
function stats() {
  const out = {};
  for (const [subnet, set] of _subnetPeers) {
    out[subnet] = set.size;
  }
  return out;
}

module.exports = {
  register,
  unregister,
  stats,
  extractSubnet,
  MAX_PEERS_PER_SUBNET,
};
