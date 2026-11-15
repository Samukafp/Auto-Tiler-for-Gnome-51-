// Números de workspace na barra superior (estilo Hyprland): mostra 1 2 3 ... com o
// activo realçado, em vez dos pontos do GNOME. Clicar muda de workspace; a roda do
// rato percorre-os. Com a definição desligada (ou ao desactivar a extensão) o
// indicador do GNOME volta a aparecer exactamente como estava.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

const ACTIVE_STYLE = 'font-weight: bold; padding: 0 9px; border-radius: 99px; ' +
    'background-color: rgba(255,255,255,0.22);';
const IDLE_STYLE = 'padding: 0 9px; border-radius: 99px; opacity: 150;';

const NumbersButton = GObject.registerClass(
class AutoTilerWorkspaceNumbers extends PanelMenu.Button {
    constructor() {
        super(0.0, 'Auto Tiler: workspaces', true);
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

    _rebuild() {
        this._box.destroy_all_children();
        const active = this._wm.get_active_workspace_index();
        for (let i = 0; i < this._wm.n_workspaces; i++) {
            const label = new St.Button({
                label: String(i + 1),
                style: i === active ? ACTIVE_STYLE : IDLE_STYLE,
                reactive: true,
                can_focus: true,
                track_hover: true,
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
        this._changedId = settings.gsettings.connect('changed::workspace-numbers', () => this._sync());
        this._sync();
    }

    _activities() {
        return Main.panel.statusArea?.activities?.container ?? null;
    }

    _sync() {
        const want = this._settings.workspaceNumbers;
        if (want && !this._button) {
            this._button = new NumbersButton();
            Main.panel.addToStatusArea('auto-tiler-workspaces', this._button, 0, 'left');
            const activities = this._activities();
            if (activities?.visible) {
                activities.hide(); // o Super continua a abrir a vista geral
                this._hiddenByUs = true;
            }
        } else if (!want && this._button) {
            this._teardown();
        }
    }

    _teardown() {
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
        this._teardown();
    }
}
