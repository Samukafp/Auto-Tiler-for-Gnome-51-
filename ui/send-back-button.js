// Botão na barra superior: só aparece quando há janelas trazidas por cima de uma app em
// fullscreen/maximizada; ao clicar, mandam-se de volta para o seu lugar (animação inversa).

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

const TOOLTIP_TEXT = 'Enviar as janelas de cima do fullscreen para o seu lugar';
const TOOLTIP_DELAY_MS = 500;

const SendBackButtonActor = GObject.registerClass(
class AutoTilerSendBackButton extends PanelMenu.Button {
    constructor(onAction) {
        super(0.5, 'Auto Tiler: enviar janelas para o seu lugar', true);
        this._onAction = onAction;
        this.accessible_name = TOOLTIP_TEXT;
        this.visible = false;

        this.add_child(new St.Icon({
            gicon: Gio.ThemedIcon.new_from_names(['edit-undo-symbolic', 'go-down-symbolic']),
            style_class: 'system-status-icon',
        }));

        this._tooltip = null;
        this._tooltipTimeout = 0;
        this.connect('notify::hover', () => (this.hover ? this._scheduleTooltip() : this._hideTooltip()));
        this.connect('button-press-event', (_actor, event) => {
            if (event.get_button() !== Clutter.BUTTON_PRIMARY)
                return Clutter.EVENT_PROPAGATE;
            this._hideTooltip();
            this._onAction();
            return Clutter.EVENT_STOP;
        });
        this.connect('touch-event', (_actor, event) => {
            if (event.type() !== Clutter.EventType.TOUCH_END)
                return Clutter.EVENT_PROPAGATE;
            this._onAction();
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

export class SendBackButton {
    /**
     * @param {object} manager WindowManager (sendBrought, onStateChanged)
     */
    constructor(manager) {
        this._manager = manager;
        this._button = new SendBackButtonActor(() => manager.sendBrought());
        Main.panel.addToStatusArea('auto-tiler-send-back', this._button, 1, 'right');
        this._button.setActive(manager.broughtRecords().length > 0);
        this._unsubscribe = manager.onStateChanged(state => this._button?.setActive(state.brought));
    }

    destroy() {
        this._unsubscribe?.();
        this._unsubscribe = null;
        this._button?.destroy();
        this._button = null;
    }
}
