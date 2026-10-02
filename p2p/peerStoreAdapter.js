// p2p/peerStoreAdapter.js
'use strict';

const scoring = require('./scoring');
const { loadPeers } = require('./persistence');

function exportPeers(node) {
  if (!node || !node.peerStore) return [];
  const out = [];
  for (const peerId of node.peerStore.peers.keys()) {
    try {
      const entry = node.peerStore.peers.get(peerId);
      const addrs = [];
      if (entry && entry.addresses) {
        for (const a of entry.addresses) {
          const str = a.multiaddr?.toString?.();
          if (str) addrs.push(str);
        }
      }
      out.push({
        peerId: peerId.toString(),
        addrs,
        score: scoring.get(peerId),
        lastSeen: Date.now(),
        failures: 0,
      });
    } catch {}
  }
  return out;
}

async function hydratePeerStore(node) {
  if (!node || !node.peerStore) return 0;
  const saved = loadPeers();
  const { multiaddr } = require('@multiformats/multiaddr');
  let count = 0;

  for (const p of saved) {
    try {
      const peerId = p.peerId;
      const addrs = (p.addrs || [])
        .map(s => { try { return multiaddr(s); } catch { return null; } })
        .filter(Boolean);
      if (!addrs.length) continue;

      if (typeof node.peerStore.merge === 'function') {
        await node.peerStore.merge(peerId, {
          addresses: addrs.map(ma => ({ multiaddr: ma })),
        });
      }
      if (typeof p.score === 'number') {
        const current = scoring.get(peerId);
        const delta = p.score - current;
        if (delta > 0) scoring.reward(peerId, delta);
        else if (delta < 0) scoring.penalize(peerId, -delta, 'restored');
      }
      count++;
    } catch (err) {
      console.error('[peerStoreAdapter] hydrate:', err.message);
    }
  }
  console.log(`📂 ${count} peers hidratados do disco`);
  return count;
}

module.exports = { exportPeers, hydratePeerStore };
