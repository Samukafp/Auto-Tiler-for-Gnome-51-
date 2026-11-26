// Ponto de entrada: liga o GNOME Shell aos módulos da extensão.
// Só este ficheiro, prefs.js e ui/*.js importam módulos do Shell/GI; o resto do
// código é independente e testável em Node através do objecto `host`.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {EffectsController} from './lib/effects.js';
import {moveToLaunchWorkspace} from './lib/fullscreen-launch.js';
import {TilerSettings} from './lib/settings.js';
import {StartupGuard} from './lib/startup.js';
import {WindowManager} from './lib/window-manager.js';
import {DropHint} from './ui/drop-hint.js';
import {FloatingPanel} from './ui/floating-panel.js';
import {NativeEffects} from './ui/native-effects.js';
import {FocusBorder} from './ui/focus-border.js';
import {QuickSettingsToggle} from './ui/quick-settings.js';
import {RestoreLayoutButton} from './ui/restore-button.js';
import {SendBackButton} from './ui/send-back-button.js';
import {WorkspaceNumbers} from './ui/workspace-numbers.js';
import {WindowAnimator} from './ui/window-animator.js';

export default class AutoTilerExtension extends Extension {
    enable() {
        this._startupGuard ??= new StartupGuard(
            () => Math.floor(GLib.get_monotonic_time() / 1000),
            () => Main.layoutManager?._startingUp);
        this._full = false; // tiling completo a correr? (só com a sessão desbloqueada)
        this._settings = new TilerSettings(this.getSettings());
        // Os números dos workspaces vivem também no ecrã de bloqueio (session-modes inclui
        // 'unlock-dialog'); todo o resto (tiling, bordas, atalhos) só corre com a sessão desbloqueada.
        this._numbers = null;
        try {
            this._numbers = new WorkspaceNumbers(this._settings);
        } catch (e) {
            console.error('[auto-tiler]', e);
        }
        this._modeId = Main.sessionMode.connect('updated', () => this._syncMode());
        this._syncMode();
    }

    _syncMode() {
        const locked = Main.sessionMode.currentMode === 'unlock-dialog';
        try {
            if (locked && this._full)
                this._stopFull();
            else if (!locked && !this._full)
                this._startFull();
        } catch (e) {
            console.error('[auto-tiler]', e);
        }
        this._numbers?.refresh(locked);
    }

    _startFull() {
        this._full = true;
        this._animator = new WindowAnimator();
        this._dropHint = null;
        this._manager = new WindowManager(this._createHost(), this._settings);
        console.log(`[auto-tiler] v${this.metadata['version-name']} activada; tiling=${this._settings.tilingEnabled}, ` +
            `limite=${this._settings.maxWindows}`);
        this._manager.enable(this._savedOrder ?? []);
        this._healId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 2, () => {
            this._manager?.heal();
            return GLib.SOURCE_CONTINUE;
        });

        // Extensões de efeitos (Compiz): geridas conforme o tiling e o fullscreen.
        this._effects = new EffectsController({
            isInstalled: uuid => Boolean(Main.extensionManager.lookup(uuid)),
            // ExtensionState.ENABLED === 1
            isEnabled: uuid => Main.extensionManager.lookup(uuid)?.state === 1,
            setEnabled: (uuid, on) => (on
                ? Main.extensionManager.enableExtension(uuid)
                : Main.extensionManager.disableExtension(uuid)),
            addTimeout: (ms, fn) => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
                fn();
                return GLib.SOURCE_REMOVE;
            }),
            removeTimeout: id => GLib.Source.remove(id),
            log: message => console.log('[auto-tiler]', message),
            logError: error => console.error('[auto-tiler]', error),
        }, this._settings, () => this._manager?.hasFullscreen() ?? false);
        this._unsubscribeEffects = this._manager.onStateChanged(() => this._effects?.sync());
        this._effectsChangedId = this._settings.gsettings.connect('changed', () => this._effects?.sync());
        // O Shell avisa directamente quando um monitor entra/sai de fullscreen.
        this._fullscreenId = global.display.connect('in-fullscreen-changed', () => this._syncEffectsLater());
        this._effectsIdle = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._effectsIdle = 0;
            this._effects?.sync();
            return GLib.SOURCE_REMOVE;
        });

        // Cada peça de interface é independente: se uma falhar, as outras continuam.
        this._ui = [];
        for (const create of [
            () => new QuickSettingsToggle(this._settings.gsettings, this.path),
            () => new RestoreLayoutButton(this._manager, this._settings),
            () => new SendBackButton(this._manager),
            () => new FloatingPanel(this._settings, {startupBusy: () => this._startupGuard.active()}),
            () => new NativeEffects(this._settings, win => this._manager?.restoreSolo(win) ?? false,
                win => this._manager?.soloRestoreTarget(win) ?? null,
                () => this._startupGuard.active()),
            () => new FocusBorder(this._settings, win => this._animator?.isRunning(win) ?? false),
            () => {
                const border = this._ui.find(piece => piece instanceof FocusBorder);
                this._dropHint = new DropHint(this._settings, () => border?.colors() ??
                    {c1: this._settings.focusBorderColor});
                return this._dropHint;
            },
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
        for (const dir of ['left', 'right', 'up', 'down'])
            bind(`swap-${dir}`, () => this._manager?.swapDirection(dir));
        bind('focus-next', () => this._manager?.focusNext());
        bind('toggle-pin', () => this._manager?.togglePin());
    }

    /** Depois do Shell actualizar o estado dos monitores (o seu handler corre antes do nosso idle). */
    _syncEffectsLater() {
        if (this._effectsIdle)
            return;
        this._effectsIdle = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._effectsIdle = 0;
            this._manager?._notifyState();
            this._effects?.sync();
            return GLib.SOURCE_REMOVE;
        });
    }

    // Em GNOME Shell 51 disable() não pode ser assíncrona.
    disable() {
        if (this._modeId)
            Main.sessionMode.disconnect(this._modeId);
        this._modeId = 0;
        this._stopFull();
        this._numbers?.destroy();
        this._numbers = null;
        this._keyboard = null;
        this._settings?.destroy();
        this._settings = null;
    }

    _stopFull() {
        if (!this._full)
            return;
        this._full = false;
        if (this._healId)
            GLib.Source.remove(this._healId);
        this._healId = 0;
        Main.wm.removeKeybinding('toggle-float');
        Main.wm.removeKeybinding('toggle-tiling');
        Main.wm.removeKeybinding('restore-layout');
        for (const name of ['swap-left', 'swap-right', 'swap-up', 'swap-down', 'focus-next', 'toggle-pin'])
            Main.wm.removeKeybinding(name);

        for (const piece of this._ui ?? []) {
            try {
                piece.destroy();
            } catch (e) {
                console.error('[auto-tiler]', e);
            }
        }
        this._ui = null;
        this._dropHint = null;

        if (this._fullscreenId)
            global.display.disconnect(this._fullscreenId);
        this._fullscreenId = 0;
        if (this._effectsIdle)
            GLib.Source.remove(this._effectsIdle);
        this._effectsIdle = 0;
        if (this._effectsChangedId)
            this._settings?.gsettings.disconnect(this._effectsChangedId);
        this._effectsChangedId = 0;
        this._unsubscribeEffects?.();
        this._unsubscribeEffects = null;
        // Só quando o utilizador desliga a extensão (não ao bloquear o ecrã / terminar a sessão).
        if (Main.sessionMode.currentMode === 'user')
            this._effects?.restore();
        this._effects?.destroy();
        this._effects = null;

        this._savedOrder = this._manager?.exportOrder() ?? this._savedOrder;
        this._manager?.destroy();
        this._manager = null;
        this._animator?.cancelAll();
        this._animator = null;
    }

    /** A dock da Dash to Dock: a API da extensão (dash visível) e, como alternativa, o contentor. */
    _dockActors() {
        const actors = [];
        try {
            const ext = Main.extensionManager.lookup('dash-to-dock@micxgx.gmail.com');
            const manager = ext?.stateObj?.dockManager;
            const docks = manager?._allDocks ?? (manager?.mainDock ? [manager.mainDock] : []);
            for (const dock of docks) {
                const visual = dock.dash ?? dock._box ?? dock;
                if (visual?.get_transformed_position)
                    actors.push(visual);
            }
        } catch {
            // sem API: usa o contentor
        }
        for (const actor of Main.uiGroup.get_children()) {
            if (actor.name !== 'dashtodockContainer')
                continue;
            actors.push(actor);
            // O contentor pode ter altura 0 (a dock vive nos filhos): o dash é o que se vê.
            const found = [];
            const walk = (node, depth) => {
                if (depth > 5 || !node.get_children)
                    return;
                for (const child of node.get_children()) {
                    const cls = child.constructor?.name ?? '';
                    if (child.name === 'dash' || /DockDash/.test(cls))
                        found.push(child);
                    walk(child, depth + 1);
                }
            };
            walk(actor, 0);
            actors.push(...found);
        }
        return actors;
    }

    _createHost() {
        const animator = this._animator;
        let windowGrabActive = false;
        return {
            display: global.display,
            shellWm: global.window_manager,
            workspaceManager: global.workspace_manager,
            layoutManager: Main.layoutManager,
            windowTypeNormal: Meta.WindowType.NORMAL,
            dialogTypes: [Meta.WindowType.DIALOG, Meta.WindowType.MODAL_DIALOG],
            monitorGeometry: monitor => Main.layoutManager.monitors[monitor],
            addIdle: callback => GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                callback();
                return GLib.SOURCE_REMOVE;
            }),
            // Espaço que a barra flutuante deixaria no topo se estivesse flutuante (0 se já o está a ocupar).
            barInset: (monitor, area) => this._ui?.find(piece => piece instanceof FloatingPanel)?.dockedInset(monitor, area) ?? 0,
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
            isolateFullscreenLaunch: (win, source, follow) => {
                const monitor = win.get_monitor();
                if (monitor < 0 || (Meta.prefs_get_workspaces_only_on_primary() &&
                    monitor !== Main.layoutManager.primaryIndex))
                    return false; // não teletransportar a app para outro monitor
                return moveToLaunchWorkspace({
                    manager: global.workspace_manager, win, source, follow,
                    dynamic: Meta.prefs_get_dynamic_workspaces(),
                    timestamp: global.get_current_time(),
                });
            },
            inFullscreen: () => Main.layoutManager.monitors.some(m => m.inFullscreen),
            showDropHint: rect => this._dropHint?.show(rect),
            hideDropHint: () => this._dropHint?.hide(),
            // Há um arrasto/redimensionamento do utilizador a decorrer?
            // GNOME 51 removeu get_grab_op do Display: usa os sinais do Mutter.
            setGrabActive: active => { windowGrabActive = active; },
            grabActive: () => typeof global.display.get_grab_op === 'function'
                ? global.display.get_grab_op() !== Meta.GrabOp.NONE : windowGrabActive,
            // O Mutter 51 já não tem end_grab_op: cancela-se o redimensionamento como o Esc do
            // utilizador faz (o Mutter devolve a janela ao tamanho de antes do arrasto).
            isResizeGrab: op => ['RESIZING_N', 'RESIZING_NE', 'RESIZING_E', 'RESIZING_SE', 'RESIZING_S', 'RESIZING_SW',
                'RESIZING_W', 'RESIZING_NW'].some(name => Meta.GrabOp[name] !== undefined && Meta.GrabOp[name] === op),
            // Pré-visualização só do actor (sem pedir tamanho à janela): estica-se em torno do canto
            // da moldura até ao tamanho que a janela vai ter. (Cortar com set_clip em vez de comprimir
            // não tem efeito no GNOME 51, confirmado pelo utilizador na 1.5.0.)
            previewRect: (win, rect) => {
                const actor = win.get_compositor_private();
                const f = win.get_frame_rect();
                if (!actor || f.width <= 0 || f.height <= 0 || actor.width <= 0 || actor.height <= 0)
                    return;
                actor.set_pivot_point((f.x - actor.x) / actor.width, (f.y - actor.y) / actor.height);
                actor.scale_x = rect.width / f.width;
                actor.scale_y = rect.height / f.height;
                actor.translation_x = rect.x - f.x;
                actor.translation_y = rect.y - f.y;
            },
            clearPreview: win => {
                const actor = win.get_compositor_private();
                if (!actor)
                    return;
                actor.scale_x = 1;
                actor.scale_y = 1;
                actor.translation_x = 0;
                actor.translation_y = 0;
            },
            isMoveGrab: op => Meta.GrabOp.MOVING !== undefined && Meta.GrabOp.MOVING === op,
            // Arestas pegadas num redimensionamento ('n','se',...), ou '' se não for reconhecido.
            resizeSides: op => {
                const name = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'].find(n => Meta.GrabOp[`RESIZING_${n}`] !== undefined &&
                    Meta.GrabOp[`RESIZING_${n}`] === op);
                return name ? name.toLowerCase() : '';
            },
            endGrab: () => {
                try {
                    this._keyboard ??= global.stage.context.get_backend().get_default_seat()
                        .create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
                    const now = GLib.get_monotonic_time();
                    this._keyboard.notify_keyval(now, Clutter.KEY_Escape, Clutter.KeyState.PRESSED);
                    this._keyboard.notify_keyval(now + 1000, Clutter.KEY_Escape, Clutter.KeyState.RELEASED);
                } catch (e) {
                    console.error('[auto-tiler] não consegui terminar o arrasto:', e);
                }
            },
            pointer: () => {
                const [x, y] = global.get_pointer();
                return {x, y};
            },
            startupBusy: () => this._startupGuard.active(),
            animationsAllowed: () => !this._startupGuard.active() && animator.allowed(),
            animateWindow: (win, from, to, ms, fade, soft, wait) => animator.animate(win, from, to, ms, fade, soft, wait),
            activate: win => win.activate(global.get_current_time()),
            setOpacity: (win, value) => {
                const actor = win.get_compositor_private();
                if (actor)
                    actor.opacity = value;
            },
            // Tira as transições do Shell (animação de abertura própria) para pôr a nossa no lugar.
            // remove_all_transitions deixa a escala/posição a meio da animação do Shell (0.9 → a
            // janela ficava 10 % mais pequena): repõe-as.
            cancelShellEffects: win => {
                const actor = win.get_compositor_private();
                if (!actor)
                    return;
                actor.remove_all_transitions();
                actor.set_pivot_point(0, 0);
                actor.set({scale_x: 1, scale_y: 1, translation_x: 0, translation_y: 0});
            },
            canCancelForStateChange: win => !win.get_compositor_private()?.__animationInfo,
            // Altura da Dash to Dock em baixo no monitor principal (0 se não houver).
            dockHeight: () => {
                try {
                    const monitor = Main.layoutManager.primaryMonitor;
                    if (!monitor)
                        return 0;
                    const bottom = monitor.y + monitor.height;
                    let best = 0;
                    for (const actor of this._dockActors()) {
                        if (!actor.visible)
                            continue;
                        const [x, y] = actor.get_transformed_position();
                        const [w, h] = actor.get_transformed_size();
                        // Dock em baixo: o que conta é a ALTURA do dash, e não a distância ao fundo do
                        // ecrã. Com o autohide da Dash to Dock o dash desce até fora do ecrã (y = fundo) e
                        // a distância passava a 0 / valores intermédios durante a animação.
                        if (w > h && h > 8 && y + h >= bottom - 2 && y >= bottom - h - 2 &&
                            x >= monitor.x - 1 && x < monitor.x + monitor.width)
                            best = Math.max(best, Math.round(h));
                    }
                    return best;
                } catch {
                    return 0;
                }
            },
            // Para o journal quando a dock não é medida: o que existe no ecrã com "dock" no nome.
            dockDiagnostic: () => {
                try {
                    const ext = Main.extensionManager.lookup('dash-to-dock@micxgx.gmail.com');
                    const names = Main.uiGroup.get_children()
                        .filter(a => /dock|dash/i.test(`${a.name} ${a.constructor?.name}`))
                        .map(a => {
                            const [x, y] = a.get_transformed_position();
                            const [w, h] = a.get_transformed_size();
                            return `${a.name || '?'}/${a.constructor?.name}@${Math.round(x)},${Math.round(y)} ${Math.round(w)}x${Math.round(h)}${a.visible ? '' : ' oculto'}`;
                        });
                    const inner = [];
                    const walk = (node, depth) => {
                        if (depth > 4 || !node.get_children)
                            return;
                        for (const child of node.get_children()) {
                            const [x, y] = child.get_transformed_position();
                            const [w, h] = child.get_transformed_size();
                            inner.push(`${'>'.repeat(depth + 1)}${child.name || '?'}/${child.constructor?.name}` +
                                `@${Math.round(x)},${Math.round(y)} ${Math.round(w)}x${Math.round(h)}${child.visible ? '' : ' oculto'}`);
                            walk(child, depth + 1);
                        }
                    };
                    for (const a of Main.uiGroup.get_children()) {
                        if (a.name === 'dashtodockContainer')
                            walk(a, 0);
                    }
                    return `extensão dash-to-dock ${ext ? `estado ${ext.state}` : 'não encontrada'}; ` +
                        `candidatos: ${names.join(' | ') || 'nenhum'}; dentro: ${inner.slice(0, 14).join(' | ')}`;
                } catch (e) {
                    return `erro: ${e.message}`;
                }
            },
            actorInfo: win => {
                try {
                    const actor = win.get_compositor_private();
                    if (!actor)
                        return 'sem actor';
                    const b = win.get_buffer_rect();
                    return `buffer ${b.width}x${b.height}+${b.x}+${b.y} actor ${Math.round(actor.x)},${Math.round(actor.y)} ` +
                        `${Math.round(actor.width)}x${Math.round(actor.height)} escala ${actor.scale_x.toFixed(2)}x${actor.scale_y.toFixed(2)} ` +
                        `opacidade ${actor.opacity} visível ${actor.visible}`;
                } catch (e) {
                    return `erro ${e.message}`;
                }
            },
            // Avisa quando a Dash to Dock muda de tamanho/posição ou aparece/desaparece.
            watchDock: callback => {
                const watched = new Map();
                const attach = actor => {
                    if (actor.name !== 'dashtodockContainer' || watched.has(actor))
                        return;
                    watched.set(actor, ['notify::height', 'notify::width', 'notify::y', 'notify::visible']
                        .map(name => actor.connect(name, callback)));
                };
                for (const actor of Main.uiGroup.get_children())
                    attach(actor);
                const addedId = Main.uiGroup.connect('child-added', (_group, actor) => {
                    attach(actor);
                    callback();
                });
                const removedId = Main.uiGroup.connect('child-removed', (_group, actor) => {
                    watched.delete(actor);
                    callback();
                });
                return () => {
                    Main.uiGroup.disconnect(addedId);
                    Main.uiGroup.disconnect(removedId);
                    for (const [actor, ids] of watched) {
                        for (const id of ids) {
                            try {
                                actor.disconnect(id);
                            } catch {
                                // actor já destruído
                            }
                        }
                    }
                    watched.clear();
                };
            },
            // Rede de segurança: janela invisível (opacidade 0) sem nenhuma animação nossa a tratar dela.
            revealStuck: win => {
                const actor = win.get_compositor_private();
                if (!actor || animator.isBusy(win) || actor.opacity > 1 || !actor.visible)
                    return false;
                actor.remove_all_transitions();
                actor.opacity = 255;
                return true;
            },
            // Mantém a janela a opacidade 0 (a limpeza do Shell repõe 255) até ser libertada.
            holdHidden: win => {
                const actor = win.get_compositor_private();
                if (!actor)
                    return null;
                const hold = () => {
                    if (actor.opacity !== 1)
                        actor.opacity = 1;
                };
                hold();
                const id = actor.connect('notify::opacity', hold);
                return () => {
                    try {
                        actor.disconnect(id);
                    } catch {
                        // actor destruído
                    }
                };
            },
            // Escala/deslocamento deixados no actor sem nenhuma animação nossa a decorrer.
            stuckTransform: win => {
                const actor = win.get_compositor_private();
                if (!actor || animator.isRunning(win) || actor.get_transition?.('scale-x'))
                    return null;
                const off = Math.abs(actor.scale_x - 1) > 0.005 || Math.abs(actor.scale_y - 1) > 0.005 ||
                    Math.abs(actor.translation_x) > 0.5 || Math.abs(actor.translation_y) > 0.5;
                return off ? {sx: actor.scale_x, sy: actor.scale_y} : null;
            },
            resetTransform: win => {
                const actor = win.get_compositor_private();
                if (!actor)
                    return;
                actor.remove_all_transitions();
                actor.set_pivot_point(0, 0);
                actor.set({scale_x: 1, scale_y: 1, translation_x: 0, translation_y: 0});
            },
            cancelAnimation: win => animator.cancel(win),
            cancelAllAnimations: () => animator.cancelAll(),
            now: () => Math.floor(GLib.get_monotonic_time() / 1000),
            log: message => console.log('[auto-tiler]', message),
            logError: error => console.error('[auto-tiler]', error),
        };
    }
}
