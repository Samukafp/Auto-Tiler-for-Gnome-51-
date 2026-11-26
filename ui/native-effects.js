// GNOME 51 chama _prepareAnimationInfo só para mudanças de tamanho que vai animar.
// Filtrar aqui (não em _shouldAnimateActor) deixa os restantes efeitos do Shell intactos.
import Meta from 'gi://Meta';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {SoloRestore} from './solo-restore.js';

export class NativeEffects {
    constructor(settings, restoreSolo, restoreTarget, startupBusy = () => false) {
        this._wm = Main.wm;
        const original = this._wm?._prepareAnimationInfo;
        if (typeof original !== 'function' || original.length !== 4 || !Meta.SizeChange)
            return;
        this._original = original;
        this._solo = new SoloRestore(restoreTarget);
        // Pós-sinal: o Shell já criou as transições. Mantém os seus snapshots,
        // callbacks e cleanup, mas mostra-os menos tempo. Não reinicia o timeline.
        const fullscreen = new WeakMap();
        const shellWm = global.window_manager;
        this._shellWm = shellWm;
        try {
            this._sizeChangedId = shellWm.connect_after('size-changed', (_shellwm, actor) => {
                const info = fullscreen.get(actor);
                fullscreen.delete(actor);
                if (!info || actor.__animationInfo !== info || !settings.animationsEnabled ||
                    (St.ReducedMotion && St.Settings.get().reducedMotion === St.ReducedMotion.REDUCE))
                    return;
                try {
                    const transitions = [];
                    for (const [part, props] of [[actor, ['scale-x', 'scale-y', 'translation-x', 'translation-y']],
                        [info.clone, ['x', 'y', 'scale-x', 'scale-y', 'opacity']]]) {
                        for (const prop of props) {
                            const transition = part?.get_transition(prop);
                            if (transition)
                                transitions.push(transition);
                        }
                    }
                    for (const transition of transitions) {
                        const duration = transition.get_duration();
                        if (duration > 80 && transition.get_elapsed_time() === 0)
                            transition.set_duration(Math.round(duration * 0.72));
                    }
                } catch (e) {
                    console.error('[auto-tiler] duração de ecrã inteiro:', e);
                }
            });
        } catch {
            // Noutra implementação, mantém a duração nativa.
        }
        const owner = this;
        this._patched = function (shellwm, actor, rect, change) {
            let skip = false;
            let solo = false;
            let cold = false;
            try {
                if (owner._patched)
                    owner._solo.cancel();
                if (owner._patched && settings.tilingEnabled && actor?.meta_window &&
                    !actor.__animationInfo && typeof shellwm?.completed_size_change === 'function') {
                    const {MAXIMIZE, UNMAXIMIZE, FULLSCREEN, UNFULLSCREEN} = Meta.SizeChange;
                    const known = [MAXIMIZE, UNMAXIMIZE, FULLSCREEN, UNFULLSCREEN]
                        .some(kind => kind !== undefined && kind === change);
                    // Na janela única, o tamanho correcto é o do slot. O crossfade nativo
                    // para o tamanho intermédio só introduz um segundo movimento.
                    solo = UNMAXIMIZE !== undefined && change === UNMAXIMIZE &&
                        restoreSolo(actor.meta_window);
                    const maxSize = [MAXIMIZE, UNMAXIMIZE].some(kind => kind !== undefined && kind === change);
                    cold = maxSize && startupBusy();
                    skip = cold || solo || (known && settings.skipSizeChangeEffect);
                }
            } catch (e) {
                console.error('[auto-tiler] efeito de tamanho:', e);
            }
            if (!skip) {
                const result = original.call(this, shellwm, actor, rect, change);
                const kinds = [Meta.SizeChange.FULLSCREEN, Meta.SizeChange.UNFULLSCREEN];
                if (owner._sizeChangedId && kinds.some(kind => kind !== undefined && kind === change) &&
                    actor?.__animationInfo?.clone)
                    fullscreen.set(actor, actor.__animationInfo);
                return result;
            }
            // This branch owns only the visual hand-off, not the compositor transaction.
            try {
                const system = St.Settings.get();
                if (solo && !cold && !settings.skipSizeChangeEffect && settings.animationsEnabled &&
                    system.enable_animations && (!St.ReducedMotion || system.reducedMotion !== St.ReducedMotion.REDUCE))
                    owner._solo.begin(actor, rect);
            } catch (e) {
                console.error('[auto-tiler] animação ao restaurar:', e);
            }
            // Mesmo caminho do Shell 51 quando a animação é desactivada. Sem freeze, clones
            // ou completar a operação duas vezes.
            return shellwm.completed_size_change(actor);
        };
        this._wm._prepareAnimationInfo = this._patched;
    }

    destroy() {
        this._solo?.cancel();
        if (this._sizeChangedId)
            this._shellWm.disconnect(this._sizeChangedId);
        this._sizeChangedId = 0;
        if (this._patched && this._wm._prepareAnimationInfo === this._patched)
            this._wm._prepareAnimationInfo = this._original;
        this._patched = null;
    }
}
