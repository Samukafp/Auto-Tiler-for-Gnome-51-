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

// Estilos do indicador: {texto do número, estilo activo, estilo inactivo}.
const STYLES = {
    // Comprimido (omissão): número num comprimido claro quando activo.
    pill: {
        text: i => String(i + 1),
        active: 'font-weight: bold; padding: 0 9px; border-radius: 99px; background-color: rgba(255,255,255,0.22);',
        idle: 'padding: 0 9px; border-radius: 99px; opacity: 150;',
    },
    // Sublinhado: o activo fica sublinhado por uma linha.
    underline: {
        text: i => String(i + 1),
        active: 'font-weight: bold; padding: 0 8px; border-bottom: 2px solid white;',
        idle: 'padding: 0 8px; border-bottom: 2px solid transparent; opacity: 150;',
    },
    // Quadrado: moldura arredondada à volta do activo.
    square: {
        text: i => String(i + 1),
        active: 'font-weight: bold; padding: 0 7px; border-radius: 6px; border: 1px solid white;',
        idle: 'padding: 0 7px; border-radius: 6px; border: 1px solid transparent; opacity: 150;',
    },
    // Pontos: sem números, um ponto cheio (activo) e pontos pequenos (restantes).
    dots: {
        text: () => '',
        active: 'width: 22px; height: 8px; min-width: 22px; min-height: 8px; margin: 0 3px; border-radius: 99px; background-color: white;',
        idle: 'width: 8px; height: 8px; min-width: 8px; min-height: 8px; margin: 0 3px; border-radius: 99px; background-color: rgba(255,255,255,0.4);',
    },
    // Texto simples: só o activo em negrito e opaco.
    plain: {
        text: i => String(i + 1),
        active: 'font-weight: bold; padding: 0 7px;',
        idle: 'padding: 0 7px; opacity: 110;',
    },
    // Romanos num comprimido.
    roman: {
        text: i => ROMAN[i] ?? String(i + 1),
        active: 'font-weight: bold; padding: 0 9px; border-radius: 99px; background-color: rgba(255,255,255,0.22);',
        idle: 'padding: 0 9px; border-radius: 99px; opacity: 150;',
    },
};

const NumbersButton = GObject.registerClass(
class AutoTilerWorkspaceNumbers extends PanelMenu.Button {
    constructor(settings) {
        super(0.0, 'Auto Tiler: workspaces', true);
        this._settings = settings;
        this._locked = false;
        this._box = new St.BoxLayout({style: 'spacing: 2px;', y_align: Clutter.ActorAlign.CENTER});
        this.add_child(this._box);
        this._wm = global.workspace_manager;
        this._ids = [
            [this._wm, this._wm.connect('active-workspace-changed', () => this._rebuild())],
            [this._wm, this._wm.connect('notify::n-workspaces', () => this._rebuild())],
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

    _rebuild() {
        this._box.destroy_all_children();
        const style = STYLES[this._settings.workspaceNumbersStyle] ?? STYLES.pill;
        const active = this._wm.get_active_workspace_index();
        for (let i = 0; i < this._wm.n_workspaces; i++) {
            const label = new St.Button({
                label: style.text(i),
                style: i === active ? style.active : style.idle,
                reactive: !this._locked,
                can_focus: !this._locked,
                track_hover: !this._locked,
            });
            label.connect('clicked', () => this._wm.get_workspace_by_index(i)?.activate(global.get_current_time()));
            this._box.add_child(label);
        }
    }

    destroy() {
        for (const [obj, id] of this._ids ?? [])
            obj.disconnect(id);
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
            if (activities?.visible) {
                activities.hide(); // o Super continua a abrir a vista geral
                this._hiddenByUs = true;
            }
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
