// consensus/retarget.js
// ============================================
// Ajuste de dificuldade (PoW puro)
// ============================================
// A cada RETARGET_INTERVAL blocos, reajusta a dificuldade
// para que o tempo médio entre blocos se aproxime do alvo.
// Mesma lógica do Bitcoin (simplificada).
// ============================================

const RETARGET_INTERVAL = parseInt(process.env.RETARGET_INTERVAL) || 2016;
const TARGET_BLOCK_TIME_MS = parseInt(process.env.TARGET_BLOCK_TIME_MS) || 30000;
const MIN_DIFFICULTY = parseInt(process.env.MIN_DIFFICULTY) || 1;
const MAX_DIFFICULTY = parseInt(process.env.MAX_DIFFICULTY) || 32;

/**
 * Calcula a dificuldade que o PRÓXIMO bloco deve ter.
 * 
 * @param {number} nextIndex       índice do bloco que vai ser minerado
 * @param {Array}  recentBlocks    array de blocos (com index, timestamp)
 * @param {number} currentDiff     dificuldade atual
 * @returns {number}               nova dificuldade
 */
function computeNextDifficulty(nextIndex, recentBlocks, currentDiff) {
  // Só reajusta em múltiplos do intervalo (e não no gênesis)
  if (nextIndex === 0) return currentDiff;
  if (nextIndex % RETARGET_INTERVAL !== 0) return currentDiff;

  // Precisa dos últimos RETARGET_INTERVAL blocos
  const startIdx = nextIndex - RETARGET_INTERVAL;
  if (startIdx < 0) return currentDiff;

  const first = recentBlocks.find(b => b.index === startIdx);
  const last  = recentBlocks.find(b => b.index === nextIndex - 1);

  if (!first || !last) {
    // Não temos histórico suficiente — mantém
    return currentDiff;
  }

  const actualMs = new Date(last.timestamp).getTime()
                 - new Date(first.timestamp).getTime();

  const expectedMs = RETARGET_INTERVAL * TARGET_BLOCK_TIME_MS;

  // Se minerou rápido demais, sobe dificuldade
  // Se minerou devagar demais, desce
  let newDiff = currentDiff;

  if (actualMs < expectedMs / 2) {
    newDiff = currentDiff + 1;
  } else if (actualMs > expectedMs * 2) {
    newDiff = currentDiff - 1;
  }

  // Clamp nos limites
  newDiff = Math.max(MIN_DIFFICULTY, Math.min(MAX_DIFFICULTY, newDiff));

  if (newDiff !== currentDiff) {
    console.log(`⚙️  retarget no bloco ${nextIndex}: ${currentDiff} → ${newDiff}`);
  }

  return newDiff;
}

/**
 * Calcula o "work" (trabalho) de um bloco com dada dificuldade.
 * work = 16^difficulty  (aproximação prática do 2^256/target)
 */
function blockWork(difficulty) {
  return 16n ** BigInt(difficulty);
}

module.exports = {
  computeNextDifficulty,
  blockWork,
  RETARGET_INTERVAL,
  TARGET_BLOCK_TIME_MS,
  MIN_DIFFICULTY,
  MAX_DIFFICULTY,
};
