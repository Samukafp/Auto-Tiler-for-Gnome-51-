// Cores para a borda a partir do wallpaper (lógica pura, sem GI).
//
// Não usa a cor "literal": escolhe os tons dominantes (por matiz) e ajusta a
// luminosidade e a saturação para ficarem sempre visíveis e agradáveis. Um
// wallpaper preto dá um cinza (nunca preto); um branco dá um cinza médio; um
// colorido dá tons vivos mas contidos.

export const MIN_LIGHTNESS = 0.42;
export const MAX_LIGHTNESS = 0.66;
const HUE_BINS = 12;
const ACHROMATIC_SATURATION = 0.14;

export function rgbToHsl(r, g, b) {
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    const d = max - min;
    if (d === 0)
        return {h: 0, s: 0, l};
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h;
    if (max === r)
        h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
    else if (max === g)
        h = ((b - r) / d + 2) * 60;
    else
        h = ((r - g) / d + 4) * 60;
    return {h, s, l};
}

export function hslToHex(h, s, l) {
    const hue = ((h % 360) + 360) % 360 / 360;
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    const channel = t => {
        let x = t;
        if (x < 0) x += 1;
        if (x > 1) x -= 1;
        if (x < 1 / 6) return p + (q - p) * 6 * x;
        if (x < 1 / 2) return q;
        if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
        return p;
    };
    const hex = v => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0');
    return `#${hex(channel(hue + 1 / 3))}${hex(channel(hue))}${hex(channel(hue - 1 / 3))}`;
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const hueDistance = (a, b) => {
    const d = Math.abs(a - b) % 360;
    return Math.min(d, 360 - d);
};

const MIN_CONTRAST = 0.3;

/** Distância (0..1) entre duas cores HSL: matiz pesa mais quando são saturadas. */
function contrast(a, b) {
    const sat = Math.min(a.s, b.s);
    return (hueDistance(a.hue, b.hue) / 180) * sat * 1.5 + Math.abs(a.l - b.l) * 1.5 + Math.abs(a.s - b.s) * 0.5;
}

/** Cor sólida (#rrggbb) -> par de cores para a borda. */
export function paletteFromColor(hex) {
    const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(hex ?? '');
    if (!m)
        return null;
    return paletteFromPixels({
        data: Uint8Array.from([parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16), 255]),
        width: 1, height: 1, channels: 4, rowstride: 4,
    });
}

/**
 * @param {{data: ArrayLike<number>, width: number, height: number, channels: number, rowstride: number}} image
 * @returns {{c1: string, c2: string}|null} duas cores #rrggbb, ou null sem pixéis.
 */
export function paletteFromPixels({data, width, height, channels, rowstride}) {
    const bins = Array.from({length: HUE_BINS}, () => ({weight: 0, count: 0, sSum: 0, lSum: 0, hx: 0, hy: 0}));
    let total = 0;
    let sSum = 0;
    let lSum = 0;
    const stepX = Math.max(1, Math.floor(width / 48));
    const stepY = Math.max(1, Math.floor(height / 48));
    for (let y = 0; y < height; y += stepY) {
        for (let x = 0; x < width; x += stepX) {
            const i = y * rowstride + x * channels;
            if (channels === 4 && data[i + 3] < 16)
                continue;
            const {h, s, l} = rgbToHsl(data[i] / 255, data[i + 1] / 255, data[i + 2] / 255);
            total++;
            sSum += s;
            lSum += l;
            // Pixéis quase pretos/brancos têm matiz sem significado: pesam pouco.
            const weight = s * (1 - Math.abs(2 * l - 1));
            if (weight <= 0.02)
                continue;
            const bin = bins[Math.floor(h / (360 / HUE_BINS)) % HUE_BINS];
            bin.weight += weight;
            bin.count++;
            bin.sSum += s;
            bin.lSum += l;
            bin.hx += Math.cos(h * Math.PI / 180) * weight;
            bin.hy += Math.sin(h * Math.PI / 180) * weight;
        }
    }
    if (total === 0)
        return null;

    const avgS = sSum / total;
    const avgL = lSum / total;
    const ranked = bins.filter(b => b.weight > 0).sort((a, b) => b.weight - a.weight);

    // Imagem (quase) sem cor: cinzas moderados, nunca preto nem branco.
    if (avgS < ACHROMATIC_SATURATION || ranked.length === 0 ||
        ranked[0].weight / total < 0.02) {
        const base = clamp(avgL, MIN_LIGHTNESS, MAX_LIGHTNESS - 0.1);
        const other = base >= 0.5 ? base - 0.16 : base + 0.24; // cinzas bem distintos
        return {c1: hslToHex(0, 0, base), c2: hslToHex(0, 0, clamp(other, 0.4, 0.72))};
    }

    const toColor = bin => {
        const hue = (Math.atan2(bin.hy, bin.hx) * 180 / Math.PI + 360) % 360;
        const s = clamp(bin.sSum / bin.count, 0.38, 0.85);
        const l = clamp(bin.lSum / bin.count, MIN_LIGHTNESS, MAX_LIGHTNESS);
        return {hue, s, l};
    };
    const first = toColor(ranked[0]);
    const secondBin = ranked.slice(1).find(b => hueDistance(toColor(b).hue, first.hue) >= 45 &&
        b.weight >= ranked[0].weight * 0.08);
    let second = secondBin ? toColor(secondBin) : null;
    // As duas cores têm de se distinguir BEM: o gradiente vai de uma à outra ao longo de
    // toda a borda (não é só uma emenda). Wallpapers de um só tom ganham uma segunda cor
    // vizinha no círculo cromático e com outra luminosidade.
    if (!second || contrast(first, second) < MIN_CONTRAST) {
        second = {
            hue: first.hue + 70,
            s: clamp(Math.max(first.s, 0.5), 0.38, 0.85),
            l: first.l > 0.54 ? first.l - 0.14 : first.l + 0.14,
        };
    }
    return {
        c1: hslToHex(first.hue, first.s, first.l),
        c2: hslToHex(second.hue, second.s, second.l),
    };
}
