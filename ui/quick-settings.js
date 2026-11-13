// Botão de ligar/desligar o tiling nas Definições Rápidas.

import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {QuickToggle, SystemIndicator} from 'resource:///org/gnome/shell/ui/quickSettings.js';

const TilingToggle = GObject.registerClass(
class AutoTilerToggle extends QuickToggle {
    constructor(gsettings) {
        super({
            title: 'Tiling',
            iconName: 'view-grid-symbolic',
            toggleMode: true,
        });
        this._gsettings = gsettings;
        gsettings.bind('tiling-enabled', this, 'checked', Gio.SettingsBindFlags.DEFAULT);
        this._notifyId = this.connect('notify::checked', () => this._sync());
        this._sync();
    }

    _sync() {
        this.subtitle = this.checked ? 'Ligado' : 'Desligado';
    }

    destroy() {
        if (this._notifyId)
            this.disconnect(this._notifyId);
        this._notifyId = 0;
        super.destroy();
    }
});

const TilingIndicator = GObject.registerClass(
class AutoTilerIndicator extends SystemIndicator {
    constructor(gsettings) {
        super();
        this.quickSettingsItems.push(new TilingToggle(gsettings));
    }

    destroy() {
        for (const item of this.quickSettingsItems)
            item.destroy();
        this.quickSettingsItems.length = 0;
        super.destroy();
    }
});

export class QuickSettingsToggle {
    constructor(gsettings) {
        this._indicator = new TilingIndicator(gsettings);
        Main.panel.statusArea.quickSettings.addExternalIndicator(this._indicator);
    }

    destroy() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
