// Redimensionamento LOCAL de janelas em tiling (lógica pura, sem GI).
//
// O layout automático parte o ecrã em "células" (a área de cada janela com metade do
// espaçamento de cada lado, por isso células vizinhas se tocam exactamente). Quando o
// utilizador arrasta uma aresta, só se move o segmento dessa aresta: as janelas que
// a partilham (de um lado e do outro) e nenhuma outra. Uma divisão que atravessa o
// ecrã inteiro pode, por isso, ficar "partida" em dois segmentos independentes, como
// numa grelha onde cada linha tem as suas próprias divisões.
//
// Se a janela do outro lado da aresta se estender para além do segmento, o segmento
// alarga-se até cobri-la (senão ficaria uma janela em L ou sobreposta).

import {FLOOR_SIZE} from './layout.js';

const EPS = 2;

/** Rectângulo da janela -> célula (expandida meio espaçamento para cada lado). */
export function cellOf(rect, gap) {
    const h = gap / 2;
    return {x0: rect.x - h, y0: rect.y - h, x1: rect.x + rect.width + h, y1: rect.y + rect.height + h};
}

/** Célula -> rectângulo da janela (encolhida meio espaçamento para cada lado). */
export function rectOf(cell, gap) {
    const h = gap / 2;
    const x = Math.round(cell.x0 + h);
    const y = Math.round(cell.y0 + h);
    return {
        x,
        y,
        width: Math.max(1, Math.round(cell.x1 - h) - x),
        height: Math.max(1, Math.round(cell.y1 - h) - y),
    };
}

/** Célula em píxeis -> fracções da célula da área toda (guardadas nos registos). */
export function toFractions(cell, area) {
    const w = area.x1 - area.x0;
    const h = area.y1 - area.y0;
    return {
        x0: (cell.x0 - area.x0) / w, x1: (cell.x1 - area.x0) / w,
        y0: (cell.y0 - area.y0) / h, y1: (cell.y1 - area.y0) / h,
    };
}

export function fromFractions(frac, area) {
    const w = area.x1 - area.x0;
    const h = area.y1 - area.y0;
    return {
        x0: area.x0 + frac.x0 * w, x1: area.x0 + frac.x1 * w,
        y0: area.y0 + frac.y0 * h, y1: area.y0 + frac.y1 * h,
    };
}

/**
 * Move a divisão a que pertence a aresta `edge` da janela `dragId`, no eixo `axis`.
 *
 * @param {Map<*, {x0:number,y0:number,x1:number,y1:number}>} cells Alterado no local.
 * @param {*} dragId Janela arrastada.
 * @param {'x'|'y'} axis Eixo do deslocamento.
 * @param {'start'|'end'} edge Aresta arrastada (esquerda/cima = start).
 * @param {number} position Nova posição da aresta (coordenada de célula).
 * @param {{x0:number,y0:number,x1:number,y1:number}} area Célula da área toda.
 * @param {Map<*, {width:number,height:number}>} [mins] Tamanhos mínimos (da célula).
 * @returns {boolean} Se alguma célula mudou.
 */
export function moveBoundary(cells, dragId, axis, edge, position, area, mins = new Map()) {
    const a0 = axis === 'x' ? 'x0' : 'y0';
    const a1 = axis === 'x' ? 'x1' : 'y1';
    const p0 = axis === 'x' ? 'y0' : 'x0';
    const p1 = axis === 'x' ? 'y1' : 'x1';
    const dim = axis === 'x' ? 'width' : 'height';

    const dragged = cells.get(dragId);
    if (!dragged)
        return false;
    const line = edge === 'end' ? dragged[a1] : dragged[a0];
    // Aresta no limite do ecrã: não há vizinha.
    if (Math.abs(line - (edge === 'end' ? area[a1] : area[a0])) <= EPS)
        return false;

    // Segmento da divisão e janelas dos dois lados (com alargamento até estabilizar).
    let lo = dragged[p0];
    let hi = dragged[p1];
    let before = new Set(); // terminam na linha
    let after = new Set();  // começam na linha
    for (let guard = 0; guard < cells.size + 2; guard++) {
        before = new Set();
        after = new Set();
        let grew = false;
        for (const [id, c] of cells) {
            if (Math.min(c[p1], hi) - Math.max(c[p0], lo) <= EPS)
                continue;
            if (Math.abs(c[a1] - line) <= EPS)
                before.add(id);
            else if (Math.abs(c[a0] - line) <= EPS)
                after.add(id);
            else
                continue;
            if (c[p0] < lo - EPS) {
                lo = c[p0];
                grew = true;
            }
            if (c[p1] > hi + EPS) {
                hi = c[p1];
                grew = true;
            }
        }
        if (!grew)
            break;
    }
    if (before.size === 0 || after.size === 0)
        return false;

    const minOf = id => Math.max(dim === 'width' ? FLOOR_SIZE.width : FLOOR_SIZE.height, mins.get(id)?.[dim] ?? 0);
    let lowest = -Infinity;
    let highest = Infinity;
    for (const id of before)
        lowest = Math.max(lowest, cells.get(id)[a0] + minOf(id));
    for (const id of after)
        highest = Math.min(highest, cells.get(id)[a1] - minOf(id));
    if (lowest > highest)
        return false; // não há espaço para respeitar os mínimos

    const target = Math.min(highest, Math.max(lowest, position));
    if (Math.abs(target - line) < 0.5)
        return false;
    for (const id of before)
        cells.get(id)[a1] = target;
    for (const id of after)
        cells.get(id)[a0] = target;
    return true;
}
