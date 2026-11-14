// Ponto de entrada: liga o GNOME Shell aos módulos da extensão.
// Só este ficheiro, prefs.js e ui/*.js importam módulos do Shell/GI; o resto do
// código é independente e testável em Node através do objecto `host`.

import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {TilerSettings} from './lib/settings.js';
import {WindowManager} from './lib/window-manager.js';
import {FocusBorder} from './ui/focus-border.js';
import {QuickSettingsToggle} from './ui/quick-settings.js';
import {RestoreLayoutButton} from './ui/restore-button.js';
import {WindowAnimator} from './ui/window-animator.js';

export default class AutoTilerExtension extends Extension {
    enable() {
        this._settings = new TilerSettings(this.getSettings());
        this._animator = new WindowAnimator();
        this._manager = new WindowManager(this._createHost(), this._settings);
        console.log(`[auto-tiler] v${this.metadata['version-name']} activada; tiling=${this._settings.tilingEnabled}, ` +
            `limite=${this._settings.maxWindows}`);
        this._manager.enable();

        // Cada peça de interface é independente: se uma falhar, as outras continuam.
        this._ui = [];
        for (const create of [
            () => new QuickSettingsToggle(this._settings.gsettings),
            () => new RestoreLayoutButton(this._manager, this._settings),
            () => new FocusBorder(this._settings),
        ]) {
            try {
                this._ui.push(create());
            } catch (e) {
                console.error('[auto-tiler]', e);
            }
        }

        const bind = (name, handler) => Main.wm.addKeybinding(
            name,
            this._settings.gsettings,
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL,
            handler);
        bind('toggle-float', () => this._manager?.toggleFloat());
        bind('restore-layout', () => this._manager?.restoreLayout());
        bind('toggle-tiling', () => this._manager?.toggleTiling());
    }

    // Em GNOME Shell 51 disable() não pode ser assíncrona.
    disable() {
        Main.wm.removeKeybinding('toggle-float');
        Main.wm.removeKeybinding('toggle-tiling');
        Main.wm.removeKeybinding('restore-layout');

        for (const piece of this._ui ?? []) {
            try {
                piece.destroy();
            } catch (e) {
                console.error('[auto-tiler]', e);
            }
        }
        this._ui = null;

        this._manager?.destroy();
        this._manager = null;
        this._animator?.cancelAll();
        this._animator = null;
        this._settings?.destroy();
        this._settings = null;
    }

    _createHost() {
        const animator = this._animator;
        return {
            display: global.display,
            shellWm: global.window_manager,
            workspaceManager: global.workspace_manager,
            layoutManager: Main.layoutManager,
            windowTypeNormal: Meta.WindowType.NORMAL,
            listWindows: () => global.get_window_actors()
                .map(actor => actor.meta_window)
                .filter(win => win !== null),
            addTimeout: (ms, callback) => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
                callback();
                return GLib.SOURCE_REMOVE;
            }),
            removeTimeout: id => GLib.Source.remove(id),
            // Reutiliza workspaces existentes; só cria um novo quando o índice não existe.
            moveWindowToWorkspace: (win, index) => {
                const manager = global.workspace_manager;
                while (manager.n_workspaces <= index)
                    manager.append_new_workspace(false, global.get_current_time());
                win.change_workspace_by_index(index, false);
            },
            // Há um arrasto/redimensionamento do utilizador a decorrer?
            grabActive: () => global.display.get_grab_op() !== Meta.GrabOp.NONE,
            pointer: () => {
                const [x, y] = global.get_pointer();
                return {x, y};
            },
            animationsAllowed: () => animator.allowed(),
            animateWindow: (win, from, to, ms) => animator.animate(win, from, to, ms),
            cancelAnimation: win => animator.cancel(win),
            cancelAllAnimations: () => animator.cancelAll(),
            now: () => Math.floor(GLib.get_monotonic_time() / 1000),
            log: message => console.log('[auto-tiler]', message),
            logError: error => console.error('[auto-tiler]', error),
        };
    }
}
