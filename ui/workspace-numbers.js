// Números de workspace na barra superior (estilo Hyprland): mostra 1 2 3 ... com o
// activo realçado, em vez dos pontos do GNOME. Clicar muda de workspace; a roda do
// rato percorre-os. Com a definição desligada (ou ao desactivar a extensão) o
// indicador do GNOME volta a aparecer exactamente como estava.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];

// Estilos do indicador. `slider` (opcional) é o realce que DESLIZA de um número para o outro; sem
// slider, o activo muda de estilo de uma vez. A geometria de activo/inactivo é igual (só muda o
// peso/opacidade) para o realce encaixar nos números.
const JP = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
const num = i => String(i + 1);

function slideStyle(pad, extra, slider, activeExtra = '') {
    return {
        text: num,
        active: `font-weight: bold; ${pad} ${extra} ${activeExtra}`,
        idle: `${pad} ${extra}`,
        idleOpacity: 150, // propriedade do actor (não CSS): os números inactivos ficam mais discretos
        slider,
    };
}

const STYLES = {
    pill: slideStyle('padding: 0 9px;', 'border-radius: 99px;',
        'border-radius: 99px; background-color: rgba(255,255,255,0.22);'),
    accent: slideStyle('padding: 0 10px;', 'border-radius: 99px;',
        'border-radius: 99px; background-color: -st-accent-color;', 'color: -st-accent-fg-color;'),
    glass: slideStyle('padding: 0 10px;', 'border-radius: 99px; border: 1px solid transparent;',
        'border-radius: 99px; background-color: rgba(255,255,255,0.16); border: 1px solid rgba(255,255,255,0.4);'),
    circle: slideStyle('padding: 0; width: 22px; height: 22px; min-width: 22px; min-height: 22px;', 'border-radius: 99px;',
        'border-radius: 99px; background-color: -st-accent-color;', 'color: -st-accent-fg-color;'),
    underline: slideStyle('padding: 0 8px;', 'border-bottom: 2px solid transparent;',
        'border-bottom: 2px solid white;'),
    square: slideStyle('padding: 0 7px;', 'border-radius: 6px; border: 1px solid transparent;',
        'border-radius: 6px; border: 1px solid white;'),
    kanji: {
        ...slideStyle('padding: 0 8px;', 'border-bottom: 2px solid transparent;',
            'border-bottom: 2px solid -st-accent-color;'),
        text: i => JP[i] ?? num(i),
    },
    roman: {
        ...slideStyle('padding: 0 9px;', 'border-radius: 99px;',
            'border-radius: 99px; background-color: rgba(255,255,255,0.22);'),
        text: i => ROMAN[i] ?? num(i),
    },
    // Sem realce deslizante:
    bracket: {
        text: (i, active) => (active ? `[${i + 1}]` : num(i)),
        active: 'font-weight: bold; padding: 0 6px;',
        idle: 'padding: 0 6px;',
        idleOpacity: 130,
    },
    dots: {
        text: () => '',
        active: 'width: 22px; height: 8px; min-width: 22px; min-height: 8px; margin: 0 3px; border-radius: 99px; background-color: white;',
        idle: 'width: 8px; height: 8px; min-width: 8px; min-height: 8px; margin: 0 3px; border-radius: 99px; background-color: rgba(255,255,255,0.4);',
        idleOpacity: 255,
    },
    plain: {
        text: num,
        active: 'font-weight: bold; padding: 0 7px;',
        idle: 'padding: 0 7px;',
        idleOpacity: 120,
    },
};

export {STYLES as WORKSPACE_STYLE_DEFS}; // para os testes

const SLIDE_MS = 220;

/** Procura o SwipeTracker do gesto de troca de workspace (o nome do campo varia entre versões). */
function findWorkspaceSwipeTracker() {
    const animation = Main.wm?._workspaceAnimation;
    if (!animation)
        return null;
    for (const name of Object.getOwnPropertyNames(animation)) {
        const value = animation[name];
        if (value && typeof value.confirmSwipe === 'function' && typeof value.connect === 'function')
            return value;
    }
    return null;
}

const NumbersButton = GObject.registerClass(
class AutoTilerWorkspaceNumbers extends PanelMenu.Button {
    constructor(settings) {
        super(0.0, 'Auto Tiler: workspaces', true);
        this._settings = settings;
        this._locked = false;
        this._built = '';
        this._labels = [];
        this._placed = false;
        this._target = null;
        this._gesture = false;
        // Pilha: o realce (que desliza) fica por baixo dos números.
        this._stack = new St.Widget({layout_manager: new Clutter.BinLayout(), y_align: Clutter.ActorAlign.CENTER});
        // O realce vive numa camada SEM gestor de layout (posição/tamanho explícitos): num BinLayout a
        // altura do realce ficava a 0 e só se via uma linha entre os números.
        this._track = new St.Widget({x_expand: true, y_expand: true});
        this._slider = new St.Widget({visible: false, opacity: 0});
        this._track.add_child(this._slider);
        this._box = new St.BoxLayout({style: 'spacing: 2px;', y_align: Clutter.ActorAlign.CENTER});
        this._stack.add_child(this._track);
        this._stack.add_child(this._box);
        this.add_child(this._stack);
        this._wm = global.workspace_manager;
        this._ids = [
            [this._wm, this._wm.connect('active-workspace-changed', () => this._rebuild())],
            [this._wm, this._wm.connect('notify::n-workspaces', () => this._rebuild())],
            // A posição dos números só é conhecida depois da alocação (e muda com o negrito).
            [this._box, this._box.connect('notify::allocation', () => this._syncSlider(true))],
        ];
        this.connect('scroll-event', (_a, event) => {
            const dir = event.get_scroll_direction();
            if (dir === Clutter.ScrollDirection.UP)
                this._step(-1);
            else if (dir === Clutter.ScrollDirection.DOWN)
                this._step(1);
            else
                return Clutter.EVENT_PROPAGATE;
            return Clutter.EVENT_STOP;
        });
        this._watchGesture();
        this._rebuild();
    }

    _step(delta) {
        const next = this._wm.get_active_workspace_index() + delta;
        if (next >= 0 && next < this._wm.n_workspaces)
            this._wm.get_workspace_by_index(next)?.activate(global.get_current_time());
    }

    setLocked(locked) {
        this._locked = locked;
        this._rebuild();
    }

    get _style() {
        return STYLES[this._settings.workspaceNumbersStyle] ?? STYLES.pill;
    }

    /** Actualiza os números; o realce desliza logo ao início da mudança de workspace. */
    _rebuild() {
        const name = this._settings.workspaceNumbersStyle;
        const style = this._style;
        const active = this._wm.get_active_workspace_index();
        const count = this._wm.n_workspaces;
        const signature = `${name}|${count}|${this._locked}`;
        if (signature !== this._built || this._labels.length !== count) {
            this._built = signature;
            this._box.destroy_all_children();
            this._labels = [];
            this._placed = false;
            this._target = null;
            this._slider.remove_all_transitions();
            this._slider.opacity = 0; // só aparece depois de colocado (sem piscar em x = 0)
            for (let i = 0; i < count; i++) {
                const label = new St.Button({
                    reactive: !this._locked, can_focus: !this._locked, track_hover: !this._locked,
                });
                label.connect('clicked', () => this._wm.get_workspace_by_index(i)?.activate(global.get_current_time()));
                // O negrito muda a largura: quando a alocação deste número muda, o realce reencaixa.
                label.connect('notify::allocation', () => this._syncSlider(true));
                this._box.add_child(label);
                this._labels.push(label);
            }
        }
        this._labels.forEach((label, i) => {
            label.label = style.text(i, i === active);
            label.style = i === active ? style.active : style.idle;
            label.opacity = i === active ? 255 : (style.idleOpacity ?? 255);
        });
        this._slider.visible = Boolean(style.slider);
        if (style.slider)
            this._slider.style = style.slider;
        this._syncSlider(true);
    }

    /** Posição e largura do número `i`, ou null se ainda não foi alocado. */
    _spot(i) {
        const label = this._labels[i];
        if (!label || !label.has_allocation())
            return null;
        const w = label.get_width();
        return w > 0 ? {x: label.get_x(), w} : null;
    }

    /** Posição (fraccionária) do realce para um progresso em unidades de workspace. */
    _spotAt(progress) {
        const last = this._labels.length - 1;
        if (last < 0)
            return null;
        const p = Math.max(0, Math.min(last, progress));
        const lo = Math.floor(p);
        const hi = Math.min(last, lo + 1);
        const a = this._spot(lo);
        const b = this._spot(hi);
        if (!a || !b)
            return null;
        const t = p - lo;
        return {x: a.x + (b.x - a.x) * t, w: a.w + (b.w - a.w) * t};
    }

    _moveSlider(spot, animate, duration = SLIDE_MS) {
        this._target = spot;
        this._slider.remove_all_transitions();
        this._slider.height = this._box.get_height(); // o realce tem a altura dos números
        if (animate && this._placed) {
            this._slider.ease({
                translation_x: spot.x, width: spot.w, duration, mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            });
        } else {
            this._slider.translation_x = spot.x;
            this._slider.width = spot.w;
            this._slider.opacity = 255;
        }
        this._placed = true;
    }

    _syncSlider(animate) {
        if (!this._style.slider || this._gesture)
            return;
        const spot = this._spot(this._wm.get_active_workspace_index());
        if (!spot)
            return; // ainda sem alocação: o notify::allocation do contentor volta a chamar
        const t = this._target;
        if (this._placed && t && Math.abs(t.x - spot.x) < 0.5 && Math.abs(t.w - spot.w) < 0.5)
            return;
        this._moveSlider(spot, animate);
    }

    // --- Gesto de troca de workspace no touchpad: o realce segue o dedo -------------------------

    _watchGesture() {
        this._tracker = null;
        this._trackerIds = [];
        try {
            const tracker = findWorkspaceSwipeTracker();
            if (!tracker)
                return;
            this._trackerIds = [
                tracker.connect('begin', () => {
                    this._gesture = Boolean(this._style.slider);
                    this._slider.remove_all_transitions();
                }),
                tracker.connect('update', (_t, progress) => {
                    if (!this._gesture)
                        return;
                    const spot = this._spotAt(progress);
                    if (spot) {
                        this._target = spot;
                        this._slider.height = this._box.get_height();
                        this._slider.translation_x = spot.x;
                        this._slider.width = spot.w;
                    }
                }),
                tracker.connect('end', (_t, duration, endProgress) => {
                    if (!this._gesture)
                        return;
                    this._gesture = false;
                    const spot = this._spotAt(endProgress);
                    if (spot)
                        this._moveSlider(spot, true, Math.max(80, Math.min(400, duration || SLIDE_MS)));
                }),
            ];
            this._tracker = tracker;
        } catch (e) {
            console.warn(`[auto-tiler] números: sem seguimento do gesto (${e.message})`);
            this._disconnectGesture();
        }
    }

    _disconnectGesture() {
        for (const id of this._trackerIds ?? []) {
            try {
                this._tracker?.disconnect(id);
            } catch {
                // o tracker já foi destruído
            }
        }
        this._trackerIds = [];
        this._tracker = null;
    }

    destroy() {
        this._disconnectGesture();
        this._slider?.remove_all_transitions();
        for (const [obj, id] of this._ids ?? []) {
            try {
                obj.disconnect(id);
            } catch {
                // já desligado
            }
        }
        this._ids = [];
        super.destroy();
    }
});

export class WorkspaceNumbers {
    constructor(settings) {
        this._settings = settings;
        this._button = null;
        this._hiddenByUs = false;
        this._activitiesId = 0;
        this._activities_actor = null;
        this._changedId = settings.gsettings.connect('changed::workspace-numbers', () => this._sync());
        this._styleId = settings.gsettings.connect('changed::workspace-numbers-style', () => this._button?._rebuild());
        this._sync();
    }

    _activities() {
        return Main.panel.statusArea?.activities?.container ?? null;
    }

    _sync() {
        const want = this._settings.workspaceNumbers;
        if (want && !this._button) {
            this._button = new NumbersButton(this._settings);
            Main.panel.addToStatusArea('auto-tiler-workspaces', this._button, 0, 'left');
            const activities = this._activities();
            this._hiddenByUs = true; // enquanto os números existirem, o botão de Actividades fica escondido
            if (activities?.visible)
                activities.hide(); // o Super continua a abrir a vista geral
            // O painel volta a mostrar o botão de Actividades ao bloquear/desbloquear: mantém-no escondido.
            if (activities && !this._activitiesId) {
                this._activities_actor = activities;
                this._activitiesId = activities.connect('notify::visible', () => {
                    if (this._button && this._hiddenByUs && activities.visible)
                        activities.hide();
                });
            }
        } else if (!want && this._button) {
            this._teardown();
        }
    }

    /** Mudou o modo da sessão (bloqueio/desbloqueio): o painel esconde os itens que não conhece. */
    refresh(locked) {
        if (!this._button)
            return;
        this._button.setLocked(locked);
        this._button.container.show();
        const activities = this._activities();
        if (!locked && this._hiddenByUs && activities?.visible)
            activities.hide();
    }

    _teardown() {
        if (this._activitiesId) {
            try {
                this._activities_actor.disconnect(this._activitiesId);
            } catch {
                // actor já destruído
            }
        }
        this._activitiesId = 0;
        this._activities_actor = null;
        this._button?.destroy();
        this._button = null;
        if (this._hiddenByUs) {
            // Com o ecrã bloqueado o painel decide sozinho; só se repõe na sessão normal.
            if (Main.sessionMode.currentMode === 'user')
                this._activities()?.show();
            this._hiddenByUs = false;
        }
    }

    destroy() {
        if (this._changedId)
            this._settings.gsettings.disconnect(this._changedId);
        this._changedId = 0;
        if (this._styleId)
            this._settings.gsettings.disconnect(this._styleId);
        this._styleId = 0;
        this._teardown();
    }
}
