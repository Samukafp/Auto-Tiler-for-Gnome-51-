// Geometria pura: restauro de janelas quando o tiling deixa de as gerir.

/** Fracção da largura útil usada pela janela flutuante de recurso. */
export const FALLBACK_WIDTH_FRACTION = 0.65;
/** Acima disto (em largura E altura) uma geometria guardada conta como "ecrã inteiro". */
export const NEAR_FULLSCREEN_FRACTION = 0.85;

export function isNearlyFullscreen(frame, area) {
    return frame.width >= area.width * NEAR_FULLSCREEN_FRACTION &&
        frame.height >= area.height * NEAR_FULLSCREEN_FRACTION;
}

/** Janela 16:9, centrada, com ~65% da largura útil e nunca praticamente o ecrã todo. */
export function fallbackFrame(area) {
    let width = Math.round(area.width * FALLBACK_WIDTH_FRACTION);
    let height = Math.round(width * 9 / 16);

    // Ecrãs muito largos/baixos: limita pela altura, mantendo 16:9.
    const maxHeight = Math.round(area.height * 0.8);
    if (height > maxHeight) {
        height = maxHeight;
        width = Math.round(height * 16 / 9);
    }

    return {
        x: Math.round(area.x + (area.width - width) / 2),
        y: Math.round(area.y + (area.height - height) / 2),
        width,
        height,
    };
}

/** Mantém a janela dentro da área útil (por exemplo, se o monitor mudou). */
export function clampToArea(frame, area) {
    const width = Math.min(frame.width, area.width);
    const height = Math.min(frame.height, area.height);
    return {
        x: Math.min(Math.max(frame.x, area.x), area.x + area.width - width),
        y: Math.min(Math.max(frame.y, area.y), area.y + area.height - height),
        width,
        height,
    };
}

/**
 * Geometria a que uma janela deve regressar quando o tiling a larga.
 * Usa a geometria original se existir e não for "quase ecrã inteiro";
 * caso contrário, a janela flutuante de recurso.
 */
export function restoreFrame(original, area) {
    if (!original || isNearlyFullscreen(original, area))
        return fallbackFrame(area);
    return clampToArea(original, area);
}
