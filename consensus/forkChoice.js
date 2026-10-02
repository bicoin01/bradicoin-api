// consensus/forkChoice.js
// ============================================
// Fork choice — regra "maior chainwork vence"
// ============================================
// Quando chega um bloco que não segue o nosso tip,
// pode ser:
//   (a) bloco órfão       → guarda em orphan pool
//   (b) fork mais pesado  → faz reorg
//   (c) fork mais leve    → rejeita
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
 * decide o que fazer:
 *
 *   { action: 'append', block }        → encaixa direto no tip
 *   { action: 'orphan', block }        → guarda (previousHash não bate)
 *   { action: 'reorg',  newChain }     → reorganizar para essa cadeia
 *   { action: 'reject', reason }       → rejeitar
 */
function decideFork(localChain, incomingBlock, orphanPool) {
  const tip = localChain[localChain.length - 1];

  // 1. Já temos esse bloco?
  if (localChain.find(b => b.hash === incomingBlock.hash)) {
    return { action: 'reject', reason: 'já temos esse bloco' };
  }

  // 2. Encaixa direto no tip?
  if (incomingBlock.previousHash === tip.hash &&
      incomingBlock.index === tip.index + 1) {
    return { action: 'append', block: incomingBlock };
  }

  // 3. É um fork? Tenta reconstruir a cadeia alternativa a partir
  //    dos blocos que já temos + orphan pool.
  const altChain = tryBuildAltChain(localChain, incomingBlock, orphanPool);
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
 * Usa blocos do localChain (por hash) + orphanPool.
 */
function tryBuildAltChain(localChain, incomingBlock, orphanPool) {
  // Índice rápido por hash
  const byHash = new Map();
  for (const b of localChain) byHash.set(b.hash, b);
  for (const b of orphanPool) byHash.set(b.hash, b);

  // Reconstrói do incomingBlock pra trás até achar o gênesis
  const chain = [incomingBlock];
  let cur = incomingBlock;

  while (cur.index > 0) {
    const prev = byHash.get(cur.previousHash);
    if (!prev) return null; // não conseguimos fechar a cadeia
    chain.unshift(prev);
    cur = prev;
  }

  // Deve começar no índice 0 (gênesis)
  if (chain[0].index !== 0) return null;

  return chain;
}

module.exports = { decideFork, chainworkOf, tryBuildAltChain };
