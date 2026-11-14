// Geometria pura: restauro de janelas quando o tiling deixa de as gerir.

/** Fracção da largura útil usada pela janela flutuante de recurso. */
export const FALLBACK_WIDTH_FRACTION = 0.65;
/** Acima disto (em largura E altura) uma geometria guardada conta como "ecrã inteiro". */
export const NEAR_FULLSCREEN_FRACTION = 0.85;

export function isNearlyFullscreen(frame, area) {
    return frame.width >= area.width * NEAR_FULLSCREEN_FRACTION &&
        frame.height >= area.height * NEAR_FULLSCREEN_FRACTION;
}

/** Deslocação (px) entre janelas de recurso consecutivas, para não ficarem todas empilhadas. */
export const CASCADE_PX = 40;
export const CASCADE_STEPS = 6;

/** A geometria guardada não serve (não existe ou é quase o ecrã inteiro)? */
export function usesFallback(original, area) {
    return !original || isNearlyFullscreen(original, area);
}

/**
 * Janela 16:9, centrada, com ~65% da largura útil e nunca praticamente o ecrã todo.
 * `step` > 0 desloca-a em cascata (várias janelas sem geometria original não se empilham).
 */
export function fallbackFrame(area, step = 0) {
    let width = Math.round(area.width * FALLBACK_WIDTH_FRACTION);
    let height = Math.round(width * 9 / 16);

    // Ecrãs muito largos/baixos: limita pela altura, mantendo 16:9.
    const maxHeight = Math.round(area.height * 0.8);
    if (height > maxHeight) {
        height = maxHeight;
        width = Math.round(height * 16 / 9);
    }

    const offset = (step % CASCADE_STEPS) * CASCADE_PX;
    const centredX = Math.round(area.x + (area.width - width) / 2);
    const centredY = Math.round(area.y + (area.height - height) / 2);
    return {
        x: Math.min(centredX + offset, area.x + area.width - width),
        y: Math.min(centredY + offset, area.y + area.height - height),
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
export function restoreFrame(original, area, step = 0) {
    if (usesFallback(original, area))
        return fallbackFrame(area, step);
    return clampToArea(original, area);
}
