// Decide que janelas são flutuantes: regras automáticas + escolha manual.

import {autoFloatReason, classKey, isFileChooser, isHandsOff} from './policy.js';

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

        // O WM_CLASS / app-id de muitas apps só aparece DEPOIS de a janela abrir: se mudou,
        // as regras reavaliam-se (senão uma app de excepção ficava "em tiling" para sempre).
        // O pai (transient-for) de diálogos como «Guardar como…» também pode chegar depois de a janela abrir.
        const key = `${classKey(rec.win)}|${rec.win.get_transient_for() ? 'T' : ''}${rec.win.is_attached_dialog() ? 'D' : ''}${isFileChooser(rec.win) ? 'F' : ''}`;
        if (rec.autoReason === undefined || rec.autoKey !== key) {
            if (isHandsOff(rec.win))
                return rec.autoReason === undefined ? null : rec.autoReason !== null;
            rec.autoReason = autoFloatReason(rec.win, config);
            rec.autoKey = key;
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
