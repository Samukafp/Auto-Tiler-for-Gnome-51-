// Botão discreto na barra superior: repõe a organização automática do workspace.
// Só aparece quando existe uma alteração manual; não desliga o tiling.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

const TOOLTIP_TEXT = 'Restaurar a organização original das janelas';
const TOOLTIP_DELAY_MS = 500;

const RestoreButton = GObject.registerClass(
class AutoTilerRestoreButton extends PanelMenu.Button {
    constructor(onRestore) {
        super(0.5, 'Auto Tiler: restaurar organização', true);
        this._onRestore = onRestore;
        this.accessible_name = TOOLTIP_TEXT;
        this.visible = false;

        this.add_child(new St.Icon({
            icon_name: 'view-restore-symbolic',
            style_class: 'system-status-icon',
        }));

        this._tooltip = null;
        this._tooltipTimeout = 0;
        this.connect('notify::hover', () => (this.hover ? this._scheduleTooltip() : this._hideTooltip()));
        this.connect('button-press-event', (_actor, event) => {
            if (event.get_button() !== Clutter.BUTTON_PRIMARY)
                return Clutter.EVENT_PROPAGATE;
            this._hideTooltip();
            this._onRestore();
            return Clutter.EVENT_STOP;
        });
        this.connect('touch-event', (_actor, event) => {
            if (event.type() !== Clutter.EventType.TOUCH_END)
                return Clutter.EVENT_PROPAGATE;
            this._onRestore();
            return Clutter.EVENT_STOP;
        });
    }

    _scheduleTooltip() {
        this._hideTooltip();
        this._tooltipTimeout = setTimeout(() => {
            this._tooltipTimeout = 0;
            this._showTooltip();
        }, TOOLTIP_DELAY_MS);
    }

    _showTooltip() {
        if (this._tooltip || !this.visible)
            return;
        this._tooltip = new St.Label({text: TOOLTIP_TEXT, style_class: 'dash-label'});
        Main.layoutManager.uiGroup.add_child(this._tooltip);
        const [x, y] = this.get_transformed_position();
        const [, width] = this._tooltip.get_preferred_width(-1);
        const monitor = Main.layoutManager.primaryMonitor;
        const left = Math.max(monitor.x, Math.min(x + this.width / 2 - width / 2, monitor.x + monitor.width - width));
        this._tooltip.set_position(Math.round(left), Math.round(y + this.height + 4));
    }

    _hideTooltip() {
        if (this._tooltipTimeout) {
            clearTimeout(this._tooltipTimeout);
            this._tooltipTimeout = 0;
        }
        this._tooltip?.destroy();
        this._tooltip = null;
    }

    setActive(active) {
        this.visible = active;
        if (!active)
            this._hideTooltip();
    }

    destroy() {
        this._hideTooltip();
        super.destroy();
    }
});

export class RestoreLayoutButton {
    /**
     * @param {object} manager WindowManager (hasManualChanges, restoreLayout, onStateChanged)
     */
    constructor(manager) {
        this._button = new RestoreButton(() => manager.restoreLayout());
        Main.panel.addToStatusArea('auto-tiler-restore', this._button, 0, 'right');
        this._button.setActive(manager.hasManualChanges());
        this._unsubscribe = manager.onStateChanged(state => this._button?.setActive(state.manualChanges));
    }

    destroy() {
        this._unsubscribe?.();
        this._unsubscribe = null;
        this._button?.destroy();
        this._button = null;
    }
}
