// Aplicação dos layouts às janelas. É o único módulo que chama
// move_resize_frame, e fá-lo sempre com as mesmas salvaguardas:
//   - nunca em janelas fullscreen/maximizadas (verificado imediatamente antes);
//   - nunca em janelas minimizadas;
//   - só se a geometria actual for diferente do alvo (sem pedidos redundantes).
// Este módulo nunca chama maximize/unmaximize/make_fullscreen/unmake_fullscreen.
//
// Geometria original: antes do primeiro movimento de tiling a uma janela, a sua
// geometria é guardada em `rec.original` UMA só vez. As dimensões temporárias do
// tiling nunca a substituem; só é limpa quando a janela é libertada.

import {needsCascade, restoreFrame, spreadFrame} from './geometry.js';
import {DRAG_FLOOR, cellOf, fromFractions, moveBoundary, rectOf, toFractions} from './cells.js';
import {computeLayout, insetRect, sameRect} from './layout.js';
import {isHandsOff} from './policy.js';

const EQUAL_EPSILON = 0.01;

const fmt = r => `${r.width}x${r.height}+${r.x}+${r.y}`;

export class TilingEngine {
    /** @param {(message: string) => void} [log] Diagnóstico (journalctl). */
    constructor(log = () => {}) {
        this._log = log;
    }

    /** Gap, margem externa e célula da área toda (área + meio espaçamento) para `count` janelas. */
    _frame(area, config, count) {
        const alone = config.smartGaps && count === 1; // uma janela sozinha: sem espaçamentos
        const gap = alone ? 0 : config.innerGap;
        const inset = insetRect(area, alone ? 0 : config.outerGap);
        const h = gap / 2;
        return {
            gap,
            inset,
            cell: {x0: inset.x - h, y0: inset.y - h, x1: inset.x + inset.width + h, y1: inset.y + inset.height + h},
        };
    }

    /** Layout automático (sem ajustes manuais). */
    _auto(records, area, config) {
        const items = records.map(rec => ({id: rec.id, min: rec.minSize}));
        const {gap, inset} = this._frame(area, config, records.length);
        return computeLayout(inset, items, {gap, defaultRatio: config.defaultRatio});
    }

    /** Os ajustes manuais valem para este conjunto exacto de janelas? */
    _manualValid(records) {
        if (records.length === 0)
            return false;
        const sig = this._signature(records);
        return records.every(rec => rec.manual && rec.manualSig === sig);
    }

    _signature(records) {
        return records.map(rec => String(rec.id)).sort().join('|');
    }

    /**
     * Ajustes manuais de outro conjunto de janelas são ignorados (não apagados): uma
     * janela maximizada sai temporariamente do grupo e, ao voltar, o ajuste volta a valer.
     */
    reconcile() {}

    /**
     * Calcula o layout de um grupo de registos (por ordem de antiguidade): o
     * automático, ou os ajustes manuais enquanto o conjunto de janelas for o mesmo.
     * Janelas maximizadas/fullscreen fazem parte do grupo: mantêm o seu lugar lógico.
     */
    plan(records, area, config) {
        const auto = this._auto(records, area, config);
        if (!this._manualValid(records))
            return auto;
        const {gap, cell} = this._frame(area, config, records.length);
        const byId = new Map(records.map(rec => [rec.id, rec]));
        return auto.map(entry => ({
            ...entry,
            rect: rectOf(fromFractions(byId.get(entry.id).manual, cell), gap),
        }));
    }

    /**
     * @param {{skipId?:*}} [options] `skipId`: janela que o utilizador está a arrastar;
     *   entra no cálculo mas não é movida.
     * @returns {{rec:object, from:object, to:object}[]} Janelas efectivamente movidas.
     */
    layoutGroup(records, area, config, {skipId = null} = {}) {
        const entries = this.plan(records, area, config);
        const byId = new Map(records.map(rec => [rec.id, rec]));
        const moves = [];
        for (const entry of entries) {
            const rec = byId.get(entry.id);
            if (!rec)
                continue;
            if (entry.id === skipId) {
                rec.lastTarget = entry.rect;
                continue;
            }
            const move = this._apply(rec, entry.rect);
            if (move)
                moves.push(move);
        }
        return moves;
    }

    /**
     * Ajustes iguais ao layout automático deixam de contar como "alteração manual"
     * (o utilizador repôs o tamanho original à mão).
     */
    normalize(records, area, config) {
        if (!this._manualValid(records))
            return;
        const auto = this._auto(records, area, config);
        const manual = this.plan(records, area, config);
        const same = auto.every((entry, i) => sameRect(entry.rect, manual[i].rect, 2));
        if (same) {
            for (const rec of records) {
                rec.manual = null;
                rec.manualSig = null;
            }
        }
    }

    /**
     * Depois de um redimensionamento manual, converte a nova geometria da janela
     * num ajuste LOCAL: só se move a divisão que a janela partilha com as vizinhas
     * do outro lado da aresta arrastada (ver cells.js).
     * @returns {boolean} Se alguma divisão mudou.
     */
    learnFromResize(records, area, config, rec, {ignoreActual = false} = {}) {
        const entries = this.plan(records, area, config);
        const target = entries.find(e => e.id === rec.id);
        if (!target)
            return false;

        const {gap, cell: areaCell} = this._frame(area, config, records.length);
        const cells = new Map(entries.map(e => [e.id, cellOf(e.rect, gap)]));
        // Mínimos: o que a janela já revelou, o que ela recusa encolher agora (está maior do
        // que o previsto) e um chão para não esmagar uma vizinha durante o arrasto.
        const mins = new Map(records.map(r => {
            const planned = entries.find(e => e.id === r.id)?.rect;
            const actual = r === rec || ignoreActual ? null : r.win.get_frame_rect();
            const stuckW = actual && planned && actual.width > planned.width + 4 ? actual.width : 0;
            const stuckH = actual && planned && actual.height > planned.height + 4 ? actual.height : 0;
            return [r.id, {
                width: Math.max(r.minSize?.width ?? 0, stuckW, DRAG_FLOOR.width) + gap,
                height: Math.max(r.minSize?.height ?? 0, stuckH, DRAG_FLOOR.height) + gap,
            }];
        }));
        const frame = rec.win.get_frame_rect();
        const old = target.rect;
        let changed = false;

        for (const axis of ['x', 'y']) {
            const d = axis === 'x' ? 'width' : 'height';
            const oldStart = old[axis];
            const oldEnd = oldStart + old[d];
            const newStart = frame[axis];
            const newEnd = newStart + frame[d];
            const startDelta = Math.abs(newStart - oldStart);
            const endDelta = Math.abs(newEnd - oldEnd);
            if (startDelta <= 2 && endDelta <= 2)
                continue;
            const edge = endDelta >= startDelta ? 'end' : 'start';
            const position = edge === 'end' ? newEnd + gap / 2 : newStart - gap / 2;
            if (moveBoundary(cells, rec.id, axis, edge, position, areaCell, mins))
                changed = true;
        }

        if (!changed)
            return false;
        const sig = this._signature(records);
        for (const r of records) {
            r.manual = toFractions(cells.get(r.id), areaCell);
            r.manualSig = sig;
        }
        this._log(`layout: ajuste local por janela ${rec.id}`);
        return true;
    }

    /**
     * Devolve a janela à geometria que tinha antes do tiling; se não houver (ou
     * for quase o ecrã inteiro), a janela flutuante 16:9 centrada de recurso.
     * Janelas maximizadas/fullscreen não são tocadas e mantêm a geometria guardada
     * para serem libertadas quando deixarem esse estado.
     * @returns {{rec:object, from:object, to:object}|null}
     */
    release(rec, area, cascade = {n: 0}) {
        const win = rec.win;
        if (isHandsOff(win) || win.minimized)
            return null;

        const spread = needsCascade(rec.original, area);
        const taken = (cascade.taken ??= []);
        const slot = {index: cascade.n, count: Math.max(cascade.total ?? 1, 1)};
        const target = restoreFrame(rec.original, area, slot, cascade.sizePercent);
        // Duas originais credíveis podem coincidir: afasta-as; as do espalhamento já são distintas.
        const placed = spread ? target : spreadFrame(target, taken, area);
        taken.push(placed);
        if (spread)
            cascade.n++;
        const current = win.get_frame_rect();
        this._log(`libertar janela ${rec.id} (${win.get_wm_class()}): actual ${fmt(current)}, ` +
            `original ${rec.original ? fmt(rec.original) : 'desconhecida'} -> ${fmt(placed)}`);
        rec.original = null;
        rec.lastTarget = null;
        rec.releaseTarget = placed;
        if (sameRect(current, placed, 1))
            return null;

        win.move_resize_frame(false, placed.x, placed.y, placed.width, placed.height);
        return {rec, from: current, to: placed};
    }

    _apply(rec, rect) {
        const win = rec.win;
        if (isHandsOff(win) || win.minimized)
            return null;

        const current = win.get_frame_rect();
        rec.lastTarget = rect;
        if (sameRect(current, rect, 1))
            return null;

        if (!rec.original)
            rec.original = {...current};
        this._log(`mover janela ${rec.id} (${win.get_wm_class()}): ${fmt(current)} -> ${fmt(rect)}`);

        win.move_resize_frame(false, rect.x, rect.y, rect.width, rect.height);
        return {rec, from: current, to: rect};
    }
}
