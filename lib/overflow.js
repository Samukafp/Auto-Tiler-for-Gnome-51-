// Limite de janelas por workspace (puro, sem GNOME).

/**
 * Escolhe o workspace onde uma janela nova deve ficar.
 *
 * @param {number[]} counts Janelas em tiling por workspace existente (já sem minimizadas,
 *   sem excluídas do tiling e sem a janela que se está a colocar).
 * @param {number} start Workspace onde a janela abriu.
 * @param {number} limit Máximo de janelas por workspace.
 * @returns {number} Índice do workspace. Pode ser `counts.length`, o que significa
 *   "um workspace novo": só acontece quando todos os existentes a partir de `start` estão cheios.
 */
export function pickWorkspace(counts, start, limit) {
    const max = Math.max(1, Math.floor(limit));
    for (let i = start; i < counts.length; i++) {
        if ((counts[i] ?? 0) < max)
            return i;
    }
    return Math.max(start, counts.length);
}
