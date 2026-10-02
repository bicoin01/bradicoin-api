// p2p/discovery.js
const { mdns } = require('@libp2p/mdns');
const { kadDHT } = require('@libp2p/kad-dht');
const { bootstrap } = require('@libp2p/bootstrap');

function buildDiscoveryServices() {
  const bootstrapList = (process.env.BRADICOIN_BOOTSTRAP || '')
    .split(',').map(s => s.trim()).filter(Boolean);

  const services = {
    dht: kadDHT({ clientMode: false }),
    mdns: mdns({ interval: 10_000 }),
  };
  if (bootstrapList.length) {
    services.bootstrap = bootstrap({ list: bootstrapList });
  }
  return services;
}

module.exports = { buildDiscoveryServices };
