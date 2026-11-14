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

import {restoreFrame, usesFallback} from './geometry.js';
import {computeLayout, insetRect, ratioUpdatesFromResize, sameRect} from './layout.js';
import {isHandsOff} from './policy.js';

const EQUAL_EPSILON = 0.01;

const fmt = r => `${r.width}x${r.height}+${r.x}+${r.y}`;

export class TilingEngine {
    /** @param {(message: string) => void} [log] Diagnóstico (journalctl). */
    constructor(log = () => {}) {
        this._log = log;
    }

    /**
     * Calcula o layout de um grupo de registos (por ordem de antiguidade).
     * Janelas maximizadas/fullscreen fazem parte do grupo: mantêm o seu lugar lógico.
     */
    plan(records, area, config) {
        const items = records.map(rec => ({
            id: rec.id, ratio: rec.ratio, groupRatio: rec.groupRatio, min: rec.minSize,
        }));
        return computeLayout(insetRect(area, config.outerGap), items, {
            gap: config.innerGap,
            defaultRatio: config.defaultRatio,
        });
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
     * Proporções iguais à automática deixam de contar como "alteração manual"
     * (o utilizador repôs o tamanho original à mão).
     */
    normalize(records, area, config) {
        const entries = this.plan(records, area, config);
        const byId = new Map(records.map(rec => [rec.id, rec]));
        for (const entry of entries) {
            const rec = byId.get(entry.id);
            if (!rec)
                continue;
            if (rec.ratio !== null && Math.abs(rec.ratio - entry.autoRatio) < EQUAL_EPSILON)
                rec.ratio = null;
            if (rec.groupRatio !== null && Math.abs(rec.groupRatio - entry.autoGroupRatio) < EQUAL_EPSILON)
                rec.groupRatio = null;
        }
    }

    /**
     * Depois de um redimensionamento manual, converte o novo tamanho da janela
     * em proporções e guarda-as nos registos, para que o ajuste seja preservado.
     * @returns {boolean} Se alguma proporção mudou.
     */
    learnFromResize(records, area, config, rec) {
        const entries = this.plan(records, area, config);
        const index = entries.findIndex(e => e.id === rec.id);
        if (index < 0)
            return false;

        const frame = rec.win.get_frame_rect();
        const updates = ratioUpdatesFromResize(entries, index, frame);
        const byId = new Map(records.map(r => [r.id, r]));
        for (const {id, key, ratio} of updates) {
            const target = byId.get(id);
            if (target)
                target[key] = ratio;
        }
        return updates.length > 0;
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

        const fallback = usesFallback(rec.original, area);
        const target = restoreFrame(rec.original, area, fallback ? cascade.n : 0);
        if (fallback)
            cascade.n++;
        const current = win.get_frame_rect();
        this._log(`libertar janela ${rec.id} (${win.get_wm_class()}): actual ${fmt(current)}, ` +
            `original ${rec.original ? fmt(rec.original) : 'desconhecida'} -> ${fmt(target)}`);
        rec.original = null;
        rec.lastTarget = null;
        if (sameRect(current, target, 1))
            return null;

        win.move_resize_frame(false, target.x, target.y, target.width, target.height);
        return {rec, from: current, to: target};
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
