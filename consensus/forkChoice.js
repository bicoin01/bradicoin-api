// consensus/forkChoice.js
// ============================================
// Fork choice — regra "maior chainwork vence" (v2.0)
// ============================================
// 🆕 v2.0:
//   - decideFork / tryBuildAltChain agora são async
//   - tryBuildAltChain aceita fetchBlockByHash (Mongo) para
//     reconstruir fork points fora do cache em memória
// ============================================

const { blockWork } = require('./retarget');

/**
 * Calcula o chainwork acumulado de uma lista de blocos.
 */
function chainworkOf(blocks) {
  let total = 0n;
  for (const b of blocks) {
    total += blockWork(b.difficulty || 1);
  }
  return total;
}

/**
 * Dado nosso chain local e um bloco que chegou,
 * decide o que fazer.
 *
 * @param {Array}    localChain
 * @param {Object}   incomingBlock
 * @param {Array}    orphanPool
 * @param {Function} fetchBlockByHash  async (hash) => block | null
 */
async function decideFork(localChain, incomingBlock, orphanPool, fetchBlockByHash = null) {
  const tip = localChain[localChain.length - 1];

  // 1. Já temos esse bloco?
  if (localChain.find(b => b.hash === incomingBlock.hash)) {
    return { action: 'reject', reason: 'já temos esse bloco' };
  }

  // 2. Encaixa direto no tip?
  if (tip &&
      incomingBlock.previousHash === tip.hash &&
      incomingBlock.index === tip.index + 1) {
    return { action: 'append', block: incomingBlock };
  }

  // 3. É um fork? Tenta reconstruir a cadeia alternativa
  const altChain = await tryBuildAltChain(
    localChain,
    incomingBlock,
    orphanPool,
    fetchBlockByHash
  );

  if (altChain) {
    const localWork = chainworkOf(localChain);
    const altWork   = chainworkOf(altChain);

    if (altWork > localWork) {
      return { action: 'reorg', newChain: altChain };
    } else {
      return { action: 'reject', reason: 'fork tem menos work' };
    }
  }

  // 4. Não encaixa em nada → órfão
  return { action: 'orphan', block: incomingBlock };
}

/**
 * Tenta montar uma cadeia alternativa que termina em incomingBlock.
 * Usa localChain + orphanPool + (opcional) fetchBlockByHash para
 * buscar ancestrais que não estão em memória.
 */
async function tryBuildAltChain(localChain, incomingBlock, orphanPool, fetchBlockByHash = null) {
  const byHash = new Map();
  for (const b of localChain) byHash.set(b.hash, b);
  for (const b of orphanPool) byHash.set(b.hash, b);

  const chain = [incomingBlock];
  let cur = incomingBlock;

  // Limite de segurança (evita loop infinito em peers maliciosos)
  const MAX_DEPTH = 1_000_000;

  while (cur.index > 0) {
    if (chain.length > MAX_DEPTH) return null;

    let prev = byHash.get(cur.previousHash);

    if (!prev && fetchBlockByHash) {
      try {
        prev = await fetchBlockByHash(cur.previousHash);
        if (prev) byHash.set(prev.hash, prev);
      } catch (_) {
        prev = null;
      }
    }

    if (!prev) return null;
    chain.unshift(prev);
    cur = prev;
  }

  if (chain[0].index !== 0) return null;

  return chain;
}

module.exports = { decideFork, chainworkOf, tryBuildAltChain };
