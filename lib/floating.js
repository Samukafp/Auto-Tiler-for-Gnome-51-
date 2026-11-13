// Decide que janelas são flutuantes: regras automáticas + escolha manual.

import {autoFloatReason, isHandsOff} from './policy.js';

export class FloatingPolicy {
    /**
     * Uma janela está flutuante se o utilizador o decidiu (`rec.override`) ou,
     * na falta disso, se uma regra automática o indicar. A regra automática é
     * avaliada uma única vez, quando a janela está num estado "normal".
     *
     * @returns {boolean|null} null = ainda não se sabe (janela em fullscreen/maximizada).
     */
    isFloating(rec, config) {
        if (rec.override === 'float')
            return true;
        if (rec.override === 'tile')
            return false;

        if (rec.autoReason === undefined) {
            if (isHandsOff(rec.win))
                return null;
            rec.autoReason = autoFloatReason(rec.win, config);
        }
        return rec.autoReason !== null;
    }

    /** Inverte o estado efectivo da janela por decisão do utilizador. */
    toggle(rec, config) {
        const floating = this.isFloating(rec, config);
        rec.override = floating ? 'tile' : 'float';
        return rec.override === 'float';
    }
}
