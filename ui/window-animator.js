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

    animate(win, from, to, ms, fade = false) {
        const actor = win.get_compositor_private();
        if (!actor || to.width <= 0 || to.height <= 0)
            return;

        // Se já havia uma animação a meio, continua a partir de onde a janela VAI no
        // ecrã (em vez de saltar para o fim e recomeçar): é o que evita os "solavancos"
        // quando o layout muda várias vezes seguidas.
        const previous = this._running.get(win);
        if (previous && previous.actor === actor) {
            from = {
                x: previous.to.x + actor.translation_x,
                y: previous.to.y + actor.translation_y,
                width: previous.to.width * actor.scale_x,
                height: previous.to.height * actor.scale_y,
            };
            actor.disconnect(previous.destroyId);
            actor.remove_all_transitions();
            this._running.delete(win);
            if (previous.fade)
                actor.opacity = 255; // o fade da animação anterior não pode ficar a meio
        } else {
            this.cancel(win);
        }

        const destroyId = actor.connect('destroy', () => this._running.delete(win));
        this._running.set(win, {actor, destroyId, fade, to: {...to}});

        // O pivô fica no canto superior esquerdo do actor.
        actor.set_pivot_point(0, 0);
        actor.set({
            translation_x: from.x - to.x,
            translation_y: from.y - to.y,
            scale_x: from.width / to.width,
            scale_y: from.height / to.height,
        });
        // Aparecer a partir de um tom mais claro disfarça o corte quando a janela
        // muda muito de tamanho (o cliente só redesenha depois).
        const target = {
            translation_x: 0,
            translation_y: 0,
            scale_x: 1,
            scale_y: 1,
            duration: ms,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            onStopped: () => this._finish(win),
        };
        if (fade) {
            actor.opacity = fade === true ? 120 : fade;
            target.opacity = 255;
        }
        actor.ease(target);
    }

    cancel(win) {
        const entry = this._running.get(win);
        if (!entry)
            return;
        this._running.delete(win);
        try {
            entry.actor.disconnect(entry.destroyId);
            entry.actor.remove_all_transitions();
            this._reset(entry.actor, entry.fade);
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
            this._reset(entry.actor, entry.fade);
        } catch {
            // actor já destruído
        }
    }

    _reset(actor, fade = false) {
        actor.set({translation_x: 0, translation_y: 0, scale_x: 1, scale_y: 1});
        if (fade)
            actor.opacity = 255;
    }
}
