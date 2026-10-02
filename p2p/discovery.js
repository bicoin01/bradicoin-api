// p2p/discovery.js
'use strict';

const { mdns } = require('@libp2p/mdns');
const { kadDHT } = require('@libp2p/kad-dht');
const { bootstrap } = require('@libp2p/bootstrap');

/**
 * Monta os subsistemas de descoberta do nó P2P.
 *
 * ⚠️  API do libp2p v1.x:
 *   - mdns  e  bootstrap  → vão em createLibp2p({ peerDiscovery: [...] })
 *   - dht                 → vai em createLibp2p({ services: { dht } })
 *
 * Uso em p2p/index.js:
 *   const { peerDiscovery, services } = buildDiscovery();
 *   createLibp2p({ ..., peerDiscovery, services: { ..., ...services } })
 */
function buildDiscovery() {
  const bootstrapList = (process.env.BRADICOIN_BOOTSTRAP || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  // ── peerDiscovery (array) ────────────────────────────────
  const peerDiscovery = [
    mdns({ interval: 10_000 }),
  ];

  if (bootstrapList.length > 0) {
    peerDiscovery.push(
      bootstrap({
        list: bootstrapList,
        // Reduz ruído no boot
        timeout: 5_000,
      })
    );
  }

  // ── services (objeto) ────────────────────────────────────
  const services = {
    dht: kadDHT({ clientMode: false }),
  };

  return { peerDiscovery, services };
}

module.exports = { buildDiscovery };
