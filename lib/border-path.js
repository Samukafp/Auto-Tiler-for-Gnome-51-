// Geometria e cor da borda com gradiente animado (lógica pura, sem GI).
//
// O caminho é um rectângulo arredondado percorrido em polilinha; a cor de cada
// segmento depende da posição ao longo do perímetro mais uma fase que avança com
// o tempo, por isso o gradiente "anda" à volta da janela sem interrupções.

/** @returns {{x:number,y:number}[]} Pontos do perímetro (fechado), sentido horário. */
export function perimeterPoints(width, height, radius, maxSegment = 10, arcSteps = 6) {
    const r = Math.max(0, Math.min(radius, width / 2, height / 2));
    const pts = [];
    const arc = (cx, cy, from) => {
        for (let i = 0; i <= arcSteps; i++) {
            const a = from + (Math.PI / 2) * (i / arcSteps);
            pts.push({x: cx + r * Math.cos(a), y: cy + r * Math.sin(a)});
        }
    };
    arc(width - r, r, -Math.PI / 2);          // canto superior direito
    arc(width - r, height - r, 0);            // inferior direito
    arc(r, height - r, Math.PI / 2);          // inferior esquerdo
    arc(r, r, Math.PI);                       // superior esquerdo
    return subdivide(pts, maxSegment);
}

/** Parte os segmentos longos, para a cor poder variar ao longo de uma aresta recta. */
function subdivide(pts, maxSegment) {
    const out = [];
    for (let i = 0; i < pts.length; i++) {
        const a = pts[i];
        const b = pts[(i + 1) % pts.length];
        const pieces = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / maxSegment));
        for (let k = 0; k < pieces; k++) {
            out.push({x: a.x + (b.x - a.x) * (k / pieces), y: a.y + (b.y - a.y) * (k / pieces)});
        }
    }
    return out;
}

export function parseColor(hex) {
    const m = /^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})?$/.exec(hex);
    if (!m)
        return {r: 0.2, g: 0.82, b: 0.48, a: 1};
    return {
        r: parseInt(m[1], 16) / 255,
        g: parseInt(m[2], 16) / 255,
        b: parseInt(m[3], 16) / 255,
        a: m[4] ? parseInt(m[4], 16) / 255 : 1,
    };
}

/**
 * Cor na posição t (0..1 ao longo do perímetro) com a fase dada. Vai de c1 a c2 e
 * volta a c1 (onda triangular), para não haver emenda onde o perímetro fecha.
 */
export function gradientAt(c1, c2, t, phase) {
    const u = (((t + phase) % 1) + 1) % 1;
    const k = u < 0.5 ? u * 2 : (1 - u) * 2;
    return {
        r: c1.r + (c2.r - c1.r) * k,
        g: c1.g + (c2.g - c1.g) * k,
        b: c1.b + (c2.b - c1.b) * k,
        a: c1.a + (c2.a - c1.a) * k,
    };
}

/** Segundos por volta completa; 0 = parado (null). */
export function periodSeconds(speed) {
    return speed <= 0 ? null : 12 / speed;
}

/** Fase (0..1) para um instante em ms. */
export function phaseAt(nowMs, speed) {
    const period = periodSeconds(speed);
    return period === null ? 0 : ((nowMs / 1000) / period) % 1;
}
