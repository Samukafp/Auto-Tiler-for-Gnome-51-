// Animação visual de janelas (parte "Shell" da política de lib/animator.js).
//
// A geometria real da janela já mudou para o valor final. Aqui o actor da janela
// parte do aspecto antigo (translação + escala) e converge para o normal, por
// isso a animação nunca altera nem compete com a geometria real.

import Clutter from 'gi://Clutter';
import St from 'gi://St';

export class WindowAnimator {
    constructor() {
        this._running = new Map(); // Meta.Window -> {actor, destroyId}
    }

    /** Respeita a definição de animações do GNOME. */
    allowed() {
        try {
            return St.Settings.get().enable_animations;
        } catch {
            return false;
        }
    }

    animate(win, from, to, ms) {
        const actor = win.get_compositor_private();
        if (!actor || to.width <= 0 || to.height <= 0)
            return;

        this.cancel(win);

        const destroyId = actor.connect('destroy', () => this._running.delete(win));
        this._running.set(win, {actor, destroyId});

        // O pivô fica no canto superior esquerdo do actor.
        actor.set_pivot_point(0, 0);
        actor.set({
            translation_x: from.x - to.x,
            translation_y: from.y - to.y,
            scale_x: from.width / to.width,
            scale_y: from.height / to.height,
        });
        actor.ease({
            translation_x: 0,
            translation_y: 0,
            scale_x: 1,
            scale_y: 1,
            duration: ms,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            onStopped: () => this._finish(win),
        });
    }

    cancel(win) {
        const entry = this._running.get(win);
        if (!entry)
            return;
        this._running.delete(win);
        try {
            entry.actor.disconnect(entry.destroyId);
            entry.actor.remove_all_transitions();
            this._reset(entry.actor);
        } catch {
            // actor já destruído
        }
    }

    cancelAll() {
        for (const win of [...this._running.keys()])
            this.cancel(win);
    }

    _finish(win) {
        const entry = this._running.get(win);
        if (!entry)
            return;
        this._running.delete(win);
        try {
            entry.actor.disconnect(entry.destroyId);
            this._reset(entry.actor);
        } catch {
            // actor já destruído
        }
    }

    _reset(actor) {
        actor.set({translation_x: 0, translation_y: 0, scale_x: 1, scale_y: 1});
    }
}
