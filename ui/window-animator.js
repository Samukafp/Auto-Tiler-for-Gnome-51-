// Animação visual de janelas (parte "Shell" da política de lib/animator.js).
//
// A geometria real da janela já mudou para o valor final. Aqui o actor da janela
// parte do aspecto antigo (translação + escala) e converge para o normal, por
// isso a animação nunca altera nem compete com a geometria real.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

const WAIT_OPEN_MS = 500; // aberturas: apps lentas (Nautilus) demoram a assumir o tamanho do tiling
const SETTLE_MS = 90; // aberturas: o tamanho tem de se manter estável este tempo antes de aparecer
// aberturas: terminais e outras apps ajustam-se a uma grelha (não chegam ao pixel exacto do slot)
const OPEN_TOLERANCE_PX = 24;
const WAIT_MS = 120;
const WAIT_RESIZE_MS = 400; // mudança de tamanho: espera que a app redesenhe (apps GTK4/Firefox demoram)

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

    /**
     * @param {boolean} wait só arranca quando o actor já está no sítio novo (regressos ao slot):
     *   antes disso o actor ainda mostra a janela no sítio ANTIGO e a transformação aparecia
     *   deslocada para o lado oposto durante alguns frames (a janela "piscava" noutro canto).
     */
    animate(win, from, to, ms, fade = false, soft = false, wait = false) {
        const actor = win.get_compositor_private();
        if (!actor || to.width <= 0 || to.height <= 0)
            return;

        // Se já havia uma animação a meio, continua a partir de onde a janela VAI no
        // ecrã (em vez de saltar para o fim e recomeçar): é o que evita os "solavancos"
        // quando o layout muda várias vezes seguidas.
        const previous = this._running.get(win);
        if (previous && previous.actor === actor && previous.pending && previous.fade === 0 && fade !== 0) {
            // Janela a abrir (escondida à espera do tamanho final) e o layout pede-lhe um movimento:
            // não se anima (viu-se a janela a "viajar" desde o ecrã inteiro); só se actualiza o
            // destino, e o fade de abertura aparece já no sítio certo.
            previous.to = {...to};
            return;
        }
        if (previous && previous.actor === actor && previous.pending) {
            this._abortPending(previous);
            this._running.delete(win);
            // Abertura interrompida a meio da espera: a janela estava escondida (opacidade 0);
            // se a nova animação não desvanece, ficaria invisível para sempre.
            if (previous.fade === 0 && fade === false)
                actor.opacity = 255;
        } else if (previous && previous.actor === actor) {
            from = {
                x: previous.to.x + actor.translation_x,
                y: previous.to.y + actor.translation_y,
                width: previous.to.width * actor.scale_x,
                height: previous.to.height * actor.scale_y,
            };
            const opacityNow = actor.opacity;
            actor.disconnect(previous.destroyId);
            actor.remove_all_transitions();
            this._running.delete(win);
            // O fade da animação anterior NÃO se corta: continua a partir da opacidade que tem
            // (cortá-lo para 255 fazia a janela "estalar" a meio de aparecer).
            if (previous.fade !== false && fade === false && opacityNow < 255)
                fade = opacityNow;
        } else {
            this.cancel(win);
        }

        const tol = fade === 0 ? OPEN_TOLERANCE_PX : 2;
        if (wait && !this._ready(win, actor, to, tol)) {
            const entry = {actor, fade, to: {...to}, pending: true, ids: [], timeoutId: 0};
            entry.destroyId = actor.connect('destroy', () => {
                this._abortPending(entry);
                this._running.delete(win);
            });
            this._running.set(win, entry);
            if (fade === 0) {
                // Aberturas: a janela fica INVISÍVEL enquanto espera. A limpeza da animação do Shell
                // (cancelada por nós) repõe a opacidade a 255 e fazia a janela "piscar": vigia-se a
                // opacidade e volta a 0 sempre que alguém a mexa.
                const hold = () => {
                    if (actor.opacity !== 1) // 1 e não 0: com 0 a app deixa de receber frame callbacks
                        actor.opacity = 1;
                };
                hold();
                entry.ids.push(actor.connect('notify::opacity', hold));
            }
            const go = () => {
                if (this._running.get(win) !== entry)
                    return;
                this._abortPending(entry);
                this._running.delete(win);
                if (fade === 0)
                    from = {...entry.to}; // abertura: só fade, sem movimento
                this._begin(win, actor, from, entry.to, ms, fade, soft);
            };
            const open = fade === 0;
            const settle = () => {
                if (this._running.get(win) !== entry)
                    return;
                entry.settleId = 0;
                if (this._ready(win, actor, entry.to, tol))
                    go();
            };
            for (const name of ['notify::x', 'notify::y', 'notify::width', 'notify::height'])
                entry.ids.push(actor.connect(name, () => {
                    if (!this._ready(win, actor, entry.to, tol))
                        return;
                    if (!open)
                        return go();
                    // Aberturas: só aparece depois de o tamanho ficar parado (apps que reajustam).
                    if (entry.settleId)
                        GLib.Source.remove(entry.settleId);
                    entry.settleId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SETTLE_MS, () => {
                        settle();
                        return GLib.SOURCE_REMOVE;
                    });
                }));
            entry.timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, fade === 0 ? WAIT_OPEN_MS : (soft ? WAIT_MS : WAIT_RESIZE_MS), () => {
                entry.timeoutId = 0;
                if (fade === 0)
                    console.log(`[auto-tiler] abertura: tempo esgotado (${win.get_wm_class()}), aparece mesmo sem estar no tamanho final`);
                go();
                return GLib.SOURCE_REMOVE;
            });
            return;
        }
        this._begin(win, actor, from, to, ms, fade, soft);
    }

    /** O actor já mostra a geometria nova (frame e posição do buffer confirmados)? */
    _ready(win, actor, to, tol = 2) {
        try {
            const frame = win.get_frame_rect();
            const buffer = win.get_buffer_rect();
            return Math.abs(frame.x - to.x) <= tol && Math.abs(frame.y - to.y) <= tol &&
                Math.abs(frame.width - to.width) <= tol && Math.abs(frame.height - to.height) <= tol &&
                // O Mutter pode já dar como tamanho o PEDIDO; o buffer é o que a app realmente desenhou
                // (inclui sombras, nunca é menor que a janela): se não cobre o destino, a app ainda
                // não redimensionou e a janela veria-se pequena.
                buffer.width >= to.width - tol && buffer.height >= to.height - tol &&
                Math.abs(actor.x - buffer.x) <= 1 && Math.abs(actor.y - buffer.y) <= 1;
        } catch {
            return true;
        }
    }

    _abortPending(entry) {
        for (const id of entry.ids ?? []) {
            try {
                entry.actor.disconnect(id);
            } catch {
                // actor destruído
            }
        }
        entry.ids = [];
        if (entry.timeoutId)
            GLib.Source.remove(entry.timeoutId);
        entry.timeoutId = 0;
        if (entry.settleId)
            GLib.Source.remove(entry.settleId);
        entry.settleId = 0;
        try {
            entry.actor.disconnect(entry.destroyId);
        } catch {
            // actor destruído
        }
    }

    _begin(win, actor, from, to, ms, fade, soft) {
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
            // 'soft' (aparecer): arranca devagar e acaba devagar, para o desvanecer se ver bem;
            // o ease-out cubic dos movimentos faz quase tudo nos primeiros 150 ms.
            mode: soft ? Clutter.AnimationMode.EASE_IN_OUT_QUAD : Clutter.AnimationMode.EASE_OUT_CUBIC,
            onStopped: () => this._finish(win),
        };
        if (fade === 'out') {
            // Inverso de aparecer: vai até ao slot enquanto desvanece.
            target.opacity = 0;
        } else if (fade !== false) {
            actor.opacity = fade === true ? 120 : fade;
            target.opacity = 255;
        }
        actor.ease(target);
    }

    /** Há uma animação NOSSA a decorrer nesta janela? (a borda só a acompanha nesse caso) */
    /** Há alguma animação NOSSA (a decorrer ou à espera de arrancar) nesta janela? */
    isBusy(win) {
        return this._running.has(win);
    }

    isRunning(win) {
        const entry = this._running.get(win);
        return !!entry && !entry.pending;
    }

    cancel(win) {
        const entry = this._running.get(win);
        if (!entry)
            return;
        this._running.delete(win);
        try {
            if (entry.pending) {
                this._abortPending(entry);
                if (entry.fade !== false)
                    entry.actor.opacity = 255; // ficou escondida à espera de arrancar
                return;
            }
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
        if (fade !== false)
            actor.opacity = 255;
    }
}
