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
    return !original || isNearlyFullscreen(original, area) ||
        original.width < MIN_RESTORE_WIDTH || original.height < MIN_RESTORE_HEIGHT;
}

/** Tamanhos mínimos para uma geometria guardada ser aproveitada (evita restaurar tamanhos provisórios). */
export const MIN_RESTORE_WIDTH = 240;
export const MIN_RESTORE_HEIGHT = 160;

/**
 * Afasta `frame` (em cascata) de qualquer geometria em `taken` com o canto quase no
 * mesmo sítio, para janelas restauradas não ficarem exactamente umas sobre as outras.
 */
export function spreadFrame(frame, taken, area) {
    let result = clampToArea(frame, area);
    for (let i = 0; i < 12; i++) {
        const clash = taken.some(t => Math.abs(t.x - result.x) < 24 && Math.abs(t.y - result.y) < 24);
        if (!clash)
            break;
        const next = clampToArea({...result, x: result.x + CASCADE_PX, y: result.y + CASCADE_PX}, area);
        // Sem espaço para descer mais: recomeça a partir do centro (nunca do canto).
        result = (next.x === result.x && next.y === result.y)
            ? centredFrame(result, area, 0)
            : next;
    }
    return result;
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

/**
 * A posição guardada é credível? Uma janela acabada de criar pode ainda estar em (0,0)
 * — canto superior esquerdo, por baixo da barra — porque o compositor ainda não a
 * colocou. Essa "posição" não é a original: não deve ser restaurada.
 */
export function isPlaced(frame, area) {
    return !(frame.x <= area.x + 2 && frame.y <= area.y + 2);
}

/** Janela com o tamanho dado (limitado à área), centrada e, se `step` > 0, em cascata. */
export function centredFrame(size, area, step = 0) {
    const width = Math.min(size.width, area.width);
    const height = Math.min(size.height, area.height);
    const offset = (step % CASCADE_STEPS) * CASCADE_PX;
    return {
        x: Math.min(Math.round(area.x + (area.width - width) / 2) + offset, area.x + area.width - width),
        y: Math.min(Math.round(area.y + (area.height - height) / 2) + offset, area.y + area.height - height),
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
    if (!isPlaced(original, area))
        return centredFrame(original, area, step); // tamanho certo, posição ainda não definida
    return clampToArea(original, area);
}

/** O destino depende do passo da cascata (não há posição original credível)? */
export function needsCascade(original, area) {
    return usesFallback(original, area) || !isPlaced(original, area);
}
