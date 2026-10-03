// p2p/diversityGuard.js
class DiversityGuard {
  constructor({
    maxPerSubnet16 = 3,   // máx 3 peers do mesmo /16 (ex: 192.168.*)
    maxPerAsn = 5,        // máx 5 peers do mesmo ASN
    maxPerCountry = 8,    // máx 8 peers do mesmo país
  } = {}) {
    this.maxPerSubnet16 = maxPerSubnet16;
    this.maxPerAsn = maxPerAsn;
    this.maxPerCountry = maxPerCountry;
  }

  _subnet16(ip) {
    return ip.split('.').slice(0, 2).join('.');
  }

  canAccept(newPeer, currentPeers) {
    const subnet = this._subnet16(newPeer.ip);
    const sameSubnet = currentPeers.filter(p =>
      this._subnet16(p.ip) === subnet
    ).length;
    if (sameSubnet >= this.maxPerSubnet16) {
      return { ok: false, reason: 'subnet_limit' };
    }

    const sameAsn = currentPeers.filter(p =>
      p.asn && p.asn === newPeer.asn
    ).length;
    if (sameAsn >= this.maxPerAsn) {
      return { ok: false, reason: 'asn_limit' };
    }

    const sameCountry = currentPeers.filter(p =>
      p.country && p.country === newPeer.country
    ).length;
    if (sameCountry >= this.maxPerCountry) {
      return { ok: false, reason: 'country_limit' };
    }

    return { ok: true };
  }

  // Remove peers se a diversidade degradar (chamado periodicamente)
  prune(currentPeers) {
    const kept = [];
    for (const p of currentPeers.sort(() => Math.random() - 0.5)) {
      const check = this.canAccept(p, kept);
      if (check.ok) kept.push(p);
    }
    return kept;
  }
}

module.exports = DiversityGuard;
