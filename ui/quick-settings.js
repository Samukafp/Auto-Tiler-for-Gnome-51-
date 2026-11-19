// Botão de ligar/desligar o tiling nas Definições Rápidas.

import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {QuickMenuToggle, SystemIndicator} from 'resource:///org/gnome/shell/ui/quickSettings.js';

const FALLBACK_ICON = 'view-dual-symbolic';

/** Ícone próprio da extensão (icons/auto-tiler-symbolic.svg); se faltar, um ícone do tema. */
function loadIcon(extensionPath) {
    try {
        const file = Gio.File.new_for_path(`${extensionPath}/icons/auto-tiler-symbolic.svg`);
        if (file.query_exists(null))
            return new Gio.FileIcon({file});
    } catch {
        // cai no ícone do tema
    }
    return new Gio.ThemedIcon({name: FALLBACK_ICON});
}

const TilingToggle = GObject.registerClass(
class AutoTilerToggle extends QuickMenuToggle {
    constructor(gsettings, icon) {
        super({
            title: 'Tiling',
            gicon: icon,
            toggleMode: true,
        });
        this._gsettings = gsettings;
        gsettings.bind('tiling-enabled', this, 'checked', Gio.SettingsBindFlags.DEFAULT);
        this._notifyId = this.connect('notify::checked', () => this._sync());
        this._sync();
        // Submenu: opções rápidas ligadas às definições.
        this.menu.setHeader(icon, 'Tiling');
        this._dockItem = new PopupMenu.PopupSwitchMenuItem('Espaço para a dock', gsettings.get_boolean('dock-reserve'));
        this._dockItem.connect('toggled', (_item, state) => gsettings.set_boolean('dock-reserve', state));
        this._dockId = gsettings.connect('changed::dock-reserve', () =>
            this._dockItem.setToggleState(gsettings.get_boolean('dock-reserve')));
        this.menu.addMenuItem(this._dockItem);
    }

    _sync() {
        this.subtitle = this.checked ? 'Ligado' : 'Desligado';
    }

    destroy() {
        if (this._notifyId)
            this.disconnect(this._notifyId);
        this._notifyId = 0;
        if (this._dockId)
            this._gsettings.disconnect(this._dockId);
        this._dockId = 0;
        super.destroy();
    }
});

const TilingIndicator = GObject.registerClass(
class AutoTilerIndicator extends SystemIndicator {
    constructor(gsettings, icon) {
        super();
        // Ícone na barra superior (junto ao volume, rede, etc.) enquanto o tiling está ligado.
        this._indicator = this._addIndicator();
        this._indicator.gicon = icon;
        gsettings.bind('tiling-enabled', this._indicator, 'visible', Gio.SettingsBindFlags.GET);
        this.quickSettingsItems.push(new TilingToggle(gsettings, icon));
    }

    destroy() {
        for (const item of this.quickSettingsItems)
            item.destroy();
        this.quickSettingsItems.length = 0;
        super.destroy();
    }
});

export class QuickSettingsToggle {
    constructor(gsettings, extensionPath) {
        this._indicator = new TilingIndicator(gsettings, loadIcon(extensionPath));
        Main.panel.statusArea.quickSettings.addExternalIndicator(this._indicator);
    }

    destroy() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
