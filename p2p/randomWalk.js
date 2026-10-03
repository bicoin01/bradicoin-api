// p2p/randomWalk.js
const crypto = require('crypto');

class RandomWalk {
  constructor(peerManager, { hops = 3, timeoutMs = 3000 } = {}) {
    this.pm = peerManager;
    this.hops = hops;
    this.timeoutMs = timeoutMs;
  }

  // Amostragem verificável: caminha k passos aleatórios, coleta prova
  async sample() {
    const path = [];
    let current = this.pm.getRandomPeerId();
    if (!current) return null;

    for (let i = 0; i < this.hops; i++) {
      const peer = this.pm.peers.get(current);
      if (!peer) break;
      path.push({
        id: current,
        nonce: crypto.randomBytes(16).toString('hex'),
        ts: Date.now(),
      });

      const next = await this._askForRandomPeer(peer, path);
      if (!next || path.find(p => p.id === next)) break;
      current = next;
    }

    return {
      path,
      proof: this._hashPath(path),
      root: path[0]?.id,
    };
  }

  _askForRandomPeer(peer, path) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), this.timeoutMs);
      peer.socket.send(JSON.stringify({
        type: 'RANDOM_PEER_REQUEST',
        pathHash: this._hashPath(path),
      }));
      peer.socket.once('message', (msg) => {
        clearTimeout(timer);
        try {
          const data = JSON.parse(msg);
          if (data.type === 'RANDOM_PEER_RESPONSE') resolve(data.peerId);
          else resolve(null);
        } catch { resolve(null); }
      });
    });
  }

  _hashPath(path) {
    return crypto.createHash('sha256')
      .update(JSON.stringify(path)).digest('hex');
  }

  // Verifica se o caminho é válido (cada nó assinou o próximo)
  verify(sample) {
    for (let i = 0; i < sample.path.length - 1; i++) {
      const expected = this._hashPath(sample.path.slice(0, i + 1));
      if (!sample.path[i].nextSignature) return false;
    }
    return true;
  }
}

module.exports = RandomWalk;
