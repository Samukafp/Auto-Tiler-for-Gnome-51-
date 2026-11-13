// Borda colorida na janela focada (opcional). Só lê a geometria da janela: nunca
// a altera, por isso não interfere com o tiling, a maximização nem o fullscreen.

import Meta from 'gi://Meta';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export class FocusBorder {
    constructor(settings) {
        this._settings = settings;
        this._widget = new St.Widget({visible: false, reactive: false});
        this._win = null;
        this._winSignals = [];
        this._displaySignals = [];

        global.window_group.add_child(this._widget);
        this._displaySignals.push(global.display.connect('notify::focus-window', () => this._follow()));
        this._displaySignals.push(Main.overview.connect('showing', () => this._update()));
        this._displaySignals.push(Main.overview.connect('hidden', () => this._update()));
        this._changedId = settings.gsettings.connect('changed', () => this._update());
        this._follow();
    }

    _follow() {
        this._unfollowWindow();
        const win = global.display.focus_window;
        if (win) {
            this._win = win;
            for (const name of ['position-changed', 'size-changed', 'notify::fullscreen',
                'notify::maximized-horizontally', 'notify::maximized-vertically', 'notify::minimized'])
                this._winSignals.push(win.connect(name, () => this._update()));
            this._winSignals.push(win.connect('unmanaging', () => this._follow()));
        }
        this._update();
    }

    _unfollowWindow() {
        if (this._win) {
            for (const id of this._winSignals) {
                try {
                    this._win.disconnect(id);
                } catch {
                    // janela já destruída
                }
            }
        }
        this._winSignals = [];
        this._win = null;
    }

    _update() {
        const win = this._win;
        try {
            const actor = win?.get_compositor_private();
            const show = this._settings.focusBorderEnabled && actor && !Main.overview.visible &&
                win.get_window_type() === Meta.WindowType.NORMAL && !win.minimized && !win.is_fullscreen() &&
                !win.maximized_horizontally && !win.maximized_vertically;
            if (!show) {
                this._widget.hide();
                return;
            }
            const w = this._settings.focusBorderWidth;
            const r = this._settings.focusBorderRadius;
            const rect = win.get_frame_rect();
            this._widget.set_style(
                `border: ${w}px solid ${this._settings.focusBorderColor}; border-radius: ${r + w}px;`);
            this._widget.set_position(rect.x - w, rect.y - w);
            this._widget.set_size(rect.width + 2 * w, rect.height + 2 * w);
            global.window_group.set_child_above_sibling(this._widget, actor);
            this._widget.show();
        } catch {
            this._widget.hide();
        }
    }

    destroy() {
        if (this._changedId)
            this._settings.gsettings.disconnect(this._changedId);
        this._changedId = 0;
        this._unfollowWindow();
        for (const [index, id] of this._displaySignals.entries()) {
            if (index === 0)
                global.display.disconnect(id);
            else
                Main.overview.disconnect(id);
        }
        this._displaySignals = [];
        this._widget?.destroy();
        this._widget = null;
    }
}
