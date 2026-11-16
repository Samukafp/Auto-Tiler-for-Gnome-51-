// Animação visual de janelas (parte "Shell" da política de lib/animator.js).
//
// A geometria real da janela já mudou para o valor final. Aqui o actor da janela
// parte do aspecto antigo (translação + escala) e converge para o normal, por
// isso a animação nunca altera nem compete com a geometria real.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

const OPACITY_SHARE = 0.55; // o fade dura esta fracção do movimento
const START_WAIT_MS = 160; // espera máxima pelo actor chegar à geometria nova

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

    animate(win, from, to, ms, fade = false, soft = false) {
        const actor = win.get_compositor_private();
        if (!actor || to.width <= 0 || to.height <= 0)
            return;

        // Se já havia uma animação a meio, continua a partir de onde a janela VAI no
        // ecrã (em vez de saltar para o fim e recomeçar): é o que evita os "solavancos"
        // quando o layout muda várias vezes seguidas.
        const previous = this._running.get(win);
        if (previous && previous.actor === actor) {
            if (previous.started) {
                from = {
                    x: previous.to.x + actor.translation_x,
                    y: previous.to.y + actor.translation_y,
                    width: previous.to.width * actor.scale_x,
                    height: previous.to.height * actor.scale_y,
                };
            }
            const opacityNow = actor.opacity;
            this._stopEntry(previous);
            actor.remove_all_transitions();
            this._running.delete(win);
            // O fade da animação anterior NÃO se corta: continua a partir da opacidade que tem
            // (cortá-lo para 255 fazia a janela "estalar" a meio de aparecer).
            if (previous.fade !== false && fade === false && opacityNow < 255)
                fade = opacityNow;
        } else {
            this.cancel(win);
        }

        const entry = {actor, win, fade, from: {...from}, to: {...to}, ms, soft, started: false, stops: []};
        entry.stops.push(() => actor.disconnect(entry.destroyId));
        entry.destroyId = actor.connect('destroy', () => {
            this._stopEntry(entry);
            this._running.delete(win);
        });
        this._running.set(win, entry);

        // Só se começa quando o actor JÁ está no sítio novo: o Wayland aplica a nova posição/tamanho
        // alguns frames depois do pedido. Começar antes deslocava a janela para o lado oposto (ela
        // "desaparecia" um instante) ou fazia-a aparecer logo no destino sem vir de lado nenhum.
        if (this._ready(win, actor, to)) {
            this._start(entry);
            return;
        }
        const go = () => {
            if (entry.started || this._running.get(win) !== entry)
                return;
            if (this._ready(win, actor, to) || entry.timedOut)
                this._start(entry);
        };
        for (const name of ['notify::x', 'notify::y', 'notify::width', 'notify::height']) {
            const id = actor.connect(name, go);
            entry.stops.push(() => actor.disconnect(id));
        }
        const timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, START_WAIT_MS, () => {
            entry.timeoutId = 0;
            entry.timedOut = true;
            go();
            return GLib.SOURCE_REMOVE;
        });
        entry.timeoutId = timer;
        entry.stops.push(() => {
            if (entry.timeoutId)
                GLib.Source.remove(entry.timeoutId);
            entry.timeoutId = 0;
        });
    }

    /** O actor já mostra a geometria nova (posição e tamanho do frame confirmados)? */
    _ready(win, actor, to) {
        try {
            const frame = win.get_frame_rect();
            const buffer = win.get_buffer_rect();
            return Math.abs(frame.x - to.x) <= 2 && Math.abs(frame.y - to.y) <= 2 &&
                Math.abs(frame.width - to.width) <= 2 && Math.abs(frame.height - to.height) <= 2 &&
                Math.abs(actor.x - buffer.x) <= 1 && Math.abs(actor.y - buffer.y) <= 1;
        } catch {
            return true;
        }
    }

    _stopEntry(entry) {
        const stops = entry.stops ?? [];
        entry.stops = [];
        for (const stop of stops) {
            try {
                stop();
            } catch {
                // objecto já destruído
            }
        }
    }

    _start(entry) {
        const {actor, win, from, to, ms, fade, soft} = entry;
        // Desliga a espera (sinais e temporizador), mantém a ligação ao 'destroy'.
        const stops = entry.stops;
        entry.stops = [stops[0]];
        for (const stop of stops.slice(1)) {
            try {
                stop();
            } catch {
                // objecto já destruído
            }
        }
        entry.started = true;

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
            // 'soft' (aparecer): arranca devagar e acaba devagar, para o desvanecer se ver bem;
            // o ease-out cubic dos movimentos faz quase tudo nos primeiros 150 ms.
            mode: soft ? Clutter.AnimationMode.EASE_IN_OUT_QUAD : Clutter.AnimationMode.EASE_OUT_CUBIC,
            onStopped: () => this._finish(win),
        };
        if (fade !== false) {
            actor.opacity = fade === true ? 120 : fade;
            // O desvanecer corre à parte e mais depressa que o movimento: com a mesma curva, a
            // janela fazia quase todo o caminho ainda invisível e parecia aparecer já no destino.
            actor.ease({
                opacity: 255,
                duration: Math.round(ms * OPACITY_SHARE),
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        }
        actor.ease(target);
    }

    /** Há uma animação NOSSA a decorrer (já começada) nesta janela? (a borda só acompanha essa) */
    isRunning(win) {
        return this._running.get(win)?.started ?? false;
    }

    cancel(win) {
        const entry = this._running.get(win);
        if (!entry)
            return;
        this._running.delete(win);
        try {
            this._stopEntry(entry);
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
            this._stopEntry(entry);
            this._reset(entry.actor, entry.fade);
        } catch {
            // actor já destruído
        }
    }

    _reset(actor, fade = false) {
        actor.set({translation_x: 0, translation_y: 0, scale_x: 1, scale_y: 1});
        if (fade !== false)
            actor.opacity = 255;
    }
}
