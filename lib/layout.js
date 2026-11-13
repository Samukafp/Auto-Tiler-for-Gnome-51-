// Cálculo puro de layouts (sem dependências do GNOME, testável em Node).
//
// Modelo: GRELHA em colunas. N janelas (da mais antiga para a mais recente) são
// distribuídas por ceil(sqrt(N)) colunas, preenchidas por ordem:
//   1 → [1]   2 → [1,1]   3 → [1,2]   4 → [2,2]   5 → [1,2,2]   6 → [2,2,2] ...
// (em ecrãs mais altos do que largos, "colunas" passam a "linhas").
// Por omissão todas as células ficam do mesmo tamanho (4 janelas = 4 quadrantes).
//
// Há duas cadeias de divisões, ambas com eixo FIXO (mudar uma proporção nunca
// faz outra divisão "virar" de eixo):
//   - `groupRatio`: divisão entre colunas, guardada na 1.ª janela da coluna;
//   - `ratio`: divisão entre as janelas de uma mesma coluna, guardada em cada janela.
// Arrastar a aresta entre colunas move a coluna inteira; arrastar a aresta entre
// duas janelas da mesma coluna só afecta essas duas.
//
// Cada divisão tem um intervalo de proporções possíveis [lo, hi] calculado a
// partir dos tamanhos mínimos das janelas de cada lado, para que nenhuma janela
// seja empurrada abaixo do seu mínimo nem sobreposta pela vizinha.

export const MIN_RATIO = 0.15;
export const MAX_RATIO = 0.85;

/** Tamanho mínimo usado quando uma janela não declara (ou ainda não revelou) o seu. */
export const FLOOR_SIZE = {width: 120, height: 90};

export function clampRatio(ratio, lo = MIN_RATIO, hi = MAX_RATIO) {
    if (!Number.isFinite(ratio))
        ratio = 0.5;
    if (lo > hi)
        return Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio));
    return Math.min(hi, Math.max(lo, ratio));
}

export function insetRect(rect, amount) {
    const a = Math.max(0, Math.round(amount));
    return {
        x: rect.x + a,
        y: rect.y + a,
        width: Math.max(1, rect.width - 2 * a),
        height: Math.max(1, rect.height - 2 * a),
    };
}

export function sameRect(a, b, tolerance = 1) {
    return Math.abs(a.x - b.x) <= tolerance &&
        Math.abs(a.y - b.y) <= tolerance &&
        Math.abs(a.width - b.width) <= tolerance &&
        Math.abs(a.height - b.height) <= tolerance;
}

function minOf(item) {
    return {
        width: Math.max(FLOOR_SIZE.width, item.min?.width ?? 0),
        height: Math.max(FLOOR_SIZE.height, item.min?.height ?? 0),
    };
}

/** Quantas janelas em cada coluna (as últimas colunas ficam com a janela a mais). */
export function columnCounts(n) {
    if (n <= 0)
        return [];
    const groups = n === 1 ? 1 : Math.ceil(Math.sqrt(n));
    const base = Math.floor(n / groups);
    const extra = n % groups;
    return Array.from({length: groups}, (_, i) => (i < groups - extra ? base : base + 1));
}

/**
 * Divide `length` por uma cadeia de elementos (cada um fica com uma fracção do
 * que resta; o último fica com o resto). `gap` separa elementos vizinhos.
 */
function splitChain(mins, ratios, length, gap, defaultRatio) {
    const n = mins.length;
    const needRest = new Array(n + 1).fill(0);
    for (let i = n - 1; i >= 0; i--)
        needRest[i] = mins[i] + (i < n - 1 ? gap + needRest[i + 1] : 0);

    const out = [];
    let remaining = length;
    let offset = 0;
    for (let i = 0; i < n; i++) {
        if (i === n - 1) {
            out.push({offset, size: remaining, span: 0, lo: 0, hi: 1, ratio: 1, auto: 1});
            break;
        }

        const span = Math.max(0, remaining - gap);
        let lo = MIN_RATIO;
        let hi = MAX_RATIO;
        if (span > 0) {
            const needLo = mins[i] / span;
            const needHi = 1 - needRest[i + 1] / span;
            if (needLo <= needHi) {
                lo = Math.max(MIN_RATIO, Math.min(needLo, MAX_RATIO));
                hi = Math.min(MAX_RATIO, Math.max(needHi, MIN_RATIO));
                if (lo > hi) {
                    lo = needLo;
                    hi = needHi;
                }
            }
        }

        // Proporção automática: partes iguais (com 2 elementos, a configurada).
        const left = n - i;
        const auto = left === 2 || span <= 0
            ? defaultRatio
            : ((remaining - (left - 1) * gap) / left) / span;
        const ratio = clampRatio(ratios[i] ?? auto, lo, hi);
        const size = Math.max(1, Math.round(span * ratio));
        out.push({offset, size, span, lo, hi, ratio, auto});
        offset += size + gap;
        remaining = Math.max(1, remaining - size - gap);
    }
    return out;
}

/**
 * @param {{x:number,y:number,width:number,height:number}} area Área já sem margem externa.
 * @param {{id:*, ratio?:number|null, groupRatio?:number|null,
 *          min?:{width:number,height:number}}[]} items Janelas por ordem de antiguidade.
 * @param {{gap?:number, defaultRatio?:number}} [options]
 * @returns {object[]} Uma entrada por janela:
 *   `rect`; `axis`/`span`/`lo`/`hi`/`ratio`/`autoRatio`: divisão com a janela seguinte da
 *   mesma coluna (axis null se for a última); `groupAxis`/`groupSpan`/`groupLo`/`groupHi`/
 *   `groupRatio`/`autoGroupRatio`: divisão entre a sua coluna e a seguinte (axis null na
 *   última coluna); `pAxis`, `groupIndex`, `groupCount`, `indexInGroup`, `groupSize`.
 */
export function computeLayout(area, items, options = {}) {
    const gap = Math.max(0, Math.round(options.gap ?? 0));
    const defaultRatio = options.defaultRatio ?? 0.5;
    const n = items.length;
    if (n === 0)
        return [];

    // Eixo das colunas: fixo, a partir da forma da área. `q` é o eixo dentro de cada coluna.
    const p = area.width >= area.height ? 'x' : 'y';
    const q = p === 'x' ? 'y' : 'x';
    const dim = axis => (axis === 'x' ? 'width' : 'height');

    const counts = columnCounts(n);
    const groups = [];
    let cursor = 0;
    for (const count of counts) {
        groups.push(items.slice(cursor, cursor + count));
        cursor += count;
    }

    const groupMins = groups.map(members =>
        Math.max(...members.map(item => minOf(item)[dim(p)])));
    const columns = splitChain(groupMins, groups.map(m => m[0].groupRatio ?? null),
        area[dim(p)], gap, defaultRatio);

    const entries = [];
    groups.forEach((members, g) => {
        const col = columns[g];
        const lastGroup = g === groups.length - 1;
        const region = {
            [p]: area[p] + col.offset,
            [q]: area[q],
            [dim(p)]: col.size,
            [dim(q)]: area[dim(q)],
        };
        const rows = splitChain(members.map(item => minOf(item)[dim(q)]),
            members.map(item => item.ratio ?? null), region[dim(q)], gap, defaultRatio);

        members.forEach((item, k) => {
            const row = rows[k];
            const lastMember = k === members.length - 1;
            const rect = {
                [p]: region[p],
                [q]: area[q] + row.offset,
                [dim(p)]: col.size,
                [dim(q)]: row.size,
            };
            entries.push({
                id: item.id,
                rect: {x: rect.x, y: rect.y, width: rect.width, height: rect.height},
                axis: lastMember ? null : q,
                span: row.span, lo: row.lo, hi: row.hi, ratio: row.ratio, autoRatio: row.auto,
                groupAxis: lastGroup ? null : p,
                groupSpan: col.span, groupLo: col.lo, groupHi: col.hi,
                groupRatio: col.ratio, autoGroupRatio: col.auto,
                gap, pAxis: p, groupIndex: g, groupCount: groups.length,
                indexInGroup: k, groupSize: members.length,
            });
        });
    });
    return entries;
}

/**
 * Quando a divisão entre os elementos k e k+1 se desloca, a divisão seguinte (k+1)
 * é uma fracção do que sobra: sem compensação, a aresta exterior de k+1 também
 * se moveria. Devolve a proporção que mantém o fim de k+1 onde estava.
 */
function keepEndFixed(next, axis, boundaryEnd, gap, span) {
    const d = axis === 'x' ? 'width' : 'height';
    const oldStart = next.rect[axis];
    const oldEnd = oldStart + next.rect[d];
    const newStart = boundaryEnd + gap;
    const newSpan = oldStart + span - newStart;
    if (newSpan <= 0 || oldEnd <= newStart)
        return null;
    return (oldEnd - newStart) / newSpan;
}

/**
 * Converte um redimensionamento manual em novas proporções, tendo em conta QUAL
 * aresta foi arrastada: arrastar a aresta esquerda de uma janela move a divisão
 * com a vizinha da esquerda (a da direita não se mexe), e vice-versa. Só essa
 * divisão muda: as janelas que não partilham aquela aresta não são afectadas.
 * Arestas junto ao limite do ecrã (sem vizinha) são ignoradas.
 *
 * @param {object[]} entries Layout calculado antes do arrasto.
 * @param {number} index Índice da janela arrastada.
 * @param {{x:number,y:number,width:number,height:number}} newRect Geometria actual da janela.
 * @returns {{id:*, key:('ratio'|'groupRatio'), ratio:number}[]}
 */
export function ratioUpdatesFromResize(entries, index, newRect, tolerance = 2) {
    const updates = [];
    const target = entries[index];
    if (!target)
        return updates;

    const firstOfGroup = g => entries.find(e => e.groupIndex === g && e.indexInGroup === 0);

    for (const axis of ['x', 'y']) {
        const d = axis === 'x' ? 'width' : 'height';
        const oldStart = target.rect[axis];
        const oldEnd = oldStart + target.rect[d];
        const newStart = newRect[axis];
        const newEnd = newStart + newRect[d];
        const startDelta = Math.abs(newStart - oldStart);
        const endDelta = Math.abs(newEnd - oldEnd);
        if (startDelta <= tolerance && endDelta <= tolerance)
            continue;
        const edge = endDelta >= startDelta ? 'end' : 'start';

        let controller = null;
        let key = 'ratio';
        let boundaryEnd = 0; // onde termina o elemento da divisão controlada
        if (axis === target.pAxis) {
            key = 'groupRatio';
            if (edge === 'end') {
                if (target.groupIndex >= target.groupCount - 1)
                    continue;
                controller = firstOfGroup(target.groupIndex);
                boundaryEnd = newEnd;
            } else {
                if (target.groupIndex === 0)
                    continue;
                controller = firstOfGroup(target.groupIndex - 1);
                boundaryEnd = newStart - target.gap;
            }
            if (!controller || controller.groupSpan <= 0)
                continue;
            const ratio = clampRatio((boundaryEnd - controller.rect[axis]) / controller.groupSpan,
                controller.groupLo, controller.groupHi);
            updates.push({id: controller.id, key, ratio});
            const next = firstOfGroup(controller.groupIndex + 1);
            if (next && next.groupAxis !== null) {
                const fixed = keepEndFixed(next, axis, controller.rect[axis] + ratio * controller.groupSpan,
                    target.gap, next.groupSpan);
                if (fixed !== null)
                    updates.push({id: next.id, key, ratio: clampRatio(fixed, next.groupLo, next.groupHi)});
            }
        } else {
            if (edge === 'end') {
                if (target.indexInGroup >= target.groupSize - 1)
                    continue;
                controller = target;
                boundaryEnd = newEnd;
            } else {
                if (target.indexInGroup === 0)
                    continue;
                controller = entries[index - 1];
                boundaryEnd = newStart - target.gap;
            }
            if (!controller || controller.span <= 0)
                continue;
            const ratio = clampRatio((boundaryEnd - controller.rect[axis]) / controller.span,
                controller.lo, controller.hi);
            updates.push({id: controller.id, key, ratio});
            const next = entries[entries.indexOf(controller) + 1];
            if (next && next.groupIndex === controller.groupIndex && next.axis !== null) {
                const fixed = keepEndFixed(next, axis, controller.rect[axis] + ratio * controller.span,
                    target.gap, next.span);
                if (fixed !== null)
                    updates.push({id: next.id, key, ratio: clampRatio(fixed, next.lo, next.hi)});
            }
        }
    }
    return updates;
}
