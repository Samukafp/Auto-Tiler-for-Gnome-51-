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
 * Uma geometria guardada só é aproveitada se for credível: bem colocada, dentro da
 * área útil, nem pequena nem enorme e com proporção entre 4:3 e 16:9 (com folga).
 * Geometrias de janelas ainda não colocadas pelo compositor (canto (0,0)), de janelas
 * que abriram maximizadas ou "compridas e estreitas" são descartadas.
 */
export function plausibleOriginal(frame, area) {
    if (!frame || frame.width <= 0 || frame.height <= 0)
        return false;
    const aspect = frame.width / frame.height;
    return aspect >= 1.2 && aspect <= 1.9 &&
        frame.width >= 400 && frame.height >= 300 &&
        frame.width <= area.width * 0.8 && frame.height <= area.height * 0.85 &&
        isPlaced(frame, area) && !touchesCorner(frame, area) &&
        frame.x >= area.x && frame.y >= area.y &&
        frame.x + frame.width <= area.x + area.width &&
        frame.y + frame.height <= area.y + area.height;
}

export const DEFAULT_NORMAL_PERCENT = 45;

/** A janela encosta a um canto do ecrã (duas bordas adjacentes ao mesmo tempo)? */
export function touchesCorner(frame, area, tolerance = 8) {
    const left = frame.x <= area.x + tolerance;
    const top = frame.y <= area.y + tolerance;
    const right = frame.x + frame.width >= area.x + area.width - tolerance;
    const bottom = frame.y + frame.height >= area.y + area.height - tolerance;
    return (left || right) && (top || bottom);
}

/** Tamanho das janelas libertadas sem geometria credível: ~16:10, nunca grande. */
export function spreadSize(area, percent = DEFAULT_NORMAL_PERCENT) {
    let width = Math.round(area.width * Math.min(0.9, Math.max(0.2, percent / 100)));
    let height = Math.round(width / 1.6);
    const maxHeight = Math.round(area.height * 0.78);
    if (height > maxHeight) {
        height = maxHeight;
        width = Math.round(height * 1.6);
    }
    return {width: Math.min(width, area.width), height: Math.min(height, area.height)};
}

/**
 * Posição `index` de `count` janelas espalhadas ao longo do ecrã (diagonal), sempre
 * dentro da área útil. Uma só janela fica centrada.
 */
export function spreadSlot(index, count, area, percent = DEFAULT_NORMAL_PERCENT) {
    const {width, height} = spreadSize(area, percent);
    // Margem em relação aos limites do ecrã: nenhuma janela encosta a um canto ou a uma borda.
    const margin = Math.max(48, Math.round(Math.min(area.width, area.height) * 0.06));
    const mx = Math.min(margin, Math.max(0, Math.floor((area.width - width) / 2)));
    const my = Math.min(margin, Math.max(0, Math.floor((area.height - height) / 2)));
    const t = count <= 1 ? 0.5 : Math.min(1, Math.max(0, index / (count - 1)));
    return {
        x: area.x + mx + Math.round(t * (area.width - width - 2 * mx)),
        y: area.y + my + Math.round(t * (area.height - height - 2 * my)),
        width,
        height,
    };
}

/**
 * Geometria a que uma janela deve regressar quando o tiling a larga: a original, se
 * credível; senão a posição `slot` (índice/total) no espalhamento pelo ecrã.
 */
export function restoreFrame(original, area, slot = {index: 0, count: 1}, percent = DEFAULT_NORMAL_PERCENT) {
    if (plausibleOriginal(original, area))
        return {...original};
    return spreadSlot(slot.index, slot.count, area, percent);
}

/** O destino vem do espalhamento (não há geometria original credível)? */
export function needsCascade(original, area) {
    return !plausibleOriginal(original, area);
}
