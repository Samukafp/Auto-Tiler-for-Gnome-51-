// Cálculo puro de layouts (sem dependências do GNOME, testável em Node).
//
// Modelo: GRELHA em colunas. N janelas (da mais antiga para a mais recente) são
// distribuídas por ceil(sqrt(N)) colunas, preenchidas por ordem:
//   1 → [1]   2 → [1,1]   3 → [1,2]   4 → [2,2]   5 → [1,2,2]   6 → [2,2,2] ...
// (em ecrãs mais altos do que largos, "colunas" passam a "linhas").
// Por omissão todas as células ficam do mesmo tamanho (4 janelas = 4 quadrantes).
//
// Este módulo só calcula o layout AUTOMÁTICO (as proporções `ratio`/`groupRatio`
// são parâmetros opcionais). Os ajustes manuais do utilizador são locais a cada
// aresta e vivem em cells.js.
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
