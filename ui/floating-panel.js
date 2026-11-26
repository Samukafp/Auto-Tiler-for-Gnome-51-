// Barra superior flutuante, como a barra de tarefas flutuante do KDE Plasma: afastada das
// margens do ecrã e com os cantos arredondados. Sempre que há uma janela maximizada ou em
// fullscreen no monitor da barra (no workspace activo) volta a ficar colada ao topo (sem margens
// nem arredondamento); quando deixa de haver, flutua de novo.
//
// Só muda o estilo do Main.panel e o padding do panelBox (nunca janelas) e repõe tudo ao ser destruída.
// As alterações vão para um idle, nunca dentro do sinal de fullscreen do Mutter.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {isOverlay} from '../lib/policy.js';

const MARGIN_SIDE = 10;
const DOCK_DELAY_MS = 75;
const MORPH_MAX_MS = 145;
const MORPH_PROPERTIES = ['translation-x', 'translation-y', 'scale-x'];
const TOUCH_TOLERANCE = 2; // px: uma janela com o topo a esta distância da barra "encosta" nela

const BMS_UUID = 'blur-my-shell@aunetx';
const BMS_SCHEMA = 'org.gnome.shell.extensions.blur-my-shell.panel';

/** Definições do painel do Blur my Shell (ele desenha o fundo da barra), ou null se não existirem. */
function openBlurSettings() {
    const ext = Main.extensionManager?.lookup(BMS_UUID);
    if (!ext || ext.state !== 1) // ExtensionState.ENABLED
        return null;
    const source = Gio.SettingsSchemaSource.new_from_directory(`${ext.path}/schemas`,
        Gio.SettingsSchemaSource.get_default(), false);
    const schema = source.lookup(BMS_SCHEMA, true);
    if (!schema || !schema.has_key('corner-radius') || !schema.has_key('rounded-corners'))
        return null;
    return new Gio.Settings({settings_schema: schema});
}

export class FloatingPanel {
    /** @param {{openBlur?: () => object|null}} [options] (os testes injectam as definições do Blur my Shell) */
    constructor(settings, {openBlur = openBlurSettings, startupBusy = () => false} = {}) {
        this._settings = settings;
        this._openBlur = openBlur;
        this._startupBusy = startupBusy;
        this._panel = Main.panel;
        this._saved = null; // estado original do painel, guardado ao flutuar pela primeira vez
        this._floating = false;
        this._idle = 0;
        this._probe = 0;
        this._delayTimer = 0;
        this._dockReady = false;
        this._destroyed = false;
        this._initialized = false; // a 1.ª aplicação (ao ligar) não anima
        this._changedIds = ['changed::floating-panel', 'changed::floating-panel-radius', 'changed::tiling-enabled',
            'changed::floating-panel-top', 'changed::floating-panel-bottom', 'changed::animations-enabled']
            .map(name => settings.gsettings.connect(name, () => this._updateLater()));
        this._fullscreenId = global.display.connect('in-fullscreen-changed', () => this._updateLater());
        this._visibilityId = Main.layoutManager.panelBox?.connect('notify::visible', () => this._updateLater());
        this._systemAnimations = St.Settings.get();
        this._systemAnimationsId = this._systemAnimations.connect('notify::enable-animations', () => this._updateLater());
        this._monitorsId = Main.layoutManager.connect('monitors-changed', () => this._updateLater());
        // Janelas maximizadas/fullscreen: ouve cada janela (as existentes e as novas) e o workspace activo.
        this._watched = new Map();
        for (const actor of global.get_window_actors?.() ?? [])
            this._watch(actor.meta_window);
        this._createdId = global.display.connect('window-created', (_d, win) => {
            this._watch(win);
            this._updateLater();
        });
        // Mover/redimensionar à mão acaba aqui: é quando uma janela pode ter encostado à barra
        // (nunca a meio do arrasto, para não mudar a área de trabalho enquanto o Mutter o gere).
        this._grabEndId = global.display.connect('grab-op-end', () => this._updateLater());
        this._workspaceId = global.workspace_manager.connect('active-workspace-changed', () => this._updateLater());
        // O fundo do Blur my Shell fica dentro do panelBox (e portanto dentro do padding): recolocá-lo.
        this._addedId = Main.layoutManager.panelBox?.connect('child-added', () => this._alignBlurGroups());
        this._update();
    }

    _watch(win) {
        if (!win || this._watched.has(win))
            return;
        const ids = ['notify::fullscreen', 'notify::maximized-horizontally', 'notify::maximized-vertically',
            'notify::minimized', 'workspace-changed', 'unmanaged']
            .map(name => win.connect(name, () => {
                if (name === 'unmanaged')
                    this._unwatch(win);
                this._updateLater();
            }));
        this._watched.set(win, ids);
    }

    _unwatch(win) {
        const ids = this._watched.get(win);
        if (!ids)
            return;
        for (const id of ids)
            win.disconnect(id);
        this._watched.delete(win);
    }

    /** Há uma janela maximizada (os 2 eixos) ou em fullscreen no monitor da barra, no workspace activo? */
    _covered() {
        const monitor = Main.layoutManager.primaryMonitor;
        if (monitor?.inFullscreen)
            return true;
        const workspace = global.workspace_manager.get_active_workspace();
        for (const actor of global.get_window_actors?.() ?? []) {
            const win = actor.meta_window;
            if (!win || win.minimized || win.get_monitor() !== monitor?.index)
                continue;
            if (win.get_workspace?.() !== workspace && !win.is_on_all_workspaces?.())
                continue;
            if (isOverlay(win))
                return true;
            // Com o tiling desligado as janelas vão para onde o utilizador as pôr: se uma encostar à
            // barra (o topo dela a chegar ao fundo da barra flutuante), a barra recolhe. A distância
            // é medida à barra FLUTUANTE, não à actual, para não oscilar entre as duas posições.
            if (!this._settings.tilingEnabled && win.get_frame_rect().y <= monitor.y + this._settings.floatingPanelTop + this._panelHeight() + this._settings.floatingPanelBottom + TOUCH_TOLERANCE)
                return true;
        }
        return false;
    }

    /**
     * Px que a barra ocuparia a mais (topo + espaço abaixo) se estivesse flutuante, quando está colada:
     * o tiling usa sempre a área «com a barra flutuante», para não reorganizar as janelas (uma segunda
     * animação) cada vez que a barra cola ou descola.
     */
    dockedInset(monitor, area) {
        const primary = Main.layoutManager.primaryMonitor;
        if (this._destroyed || !this._settings.floatingPanel || !area || monitor !== primary?.index)
            return 0;
        // Usa a área *publicada* pelo Mutter, não o estado visual da barra. A
        // strut do painel pode demorar um frame a chegar e não deve contar duas vezes.
        const extra = this._settings.floatingPanelTop + this._settings.floatingPanelBottom;
        return Math.min(extra, Math.max(0, primary.y + this._panelHeight() + extra - area.y));
    }

    _panelHeight() {
        return this._panel?.get_height?.() ?? 32;
    }

    /** O Blur my Shell desenha o fundo dentro do panelBox, que tem padding: deslocá-lo de volta. */
    _alignBlurGroups(reset = false) {
        const box = Main.layoutManager.panelBox;
        if (!box)
            return;
        for (const child of box.get_children?.() ?? []) {
            if (child.get_name?.() !== 'bms-panel-backgroundgroup' && child.name !== 'bms-panel-backgroundgroup')
                continue;
            child.translation_x = reset || !this._floating ? 0 : -MARGIN_SIDE;
            child.translation_y = reset || !this._floating ? 0 : -this._settings.floatingPanelTop;
        }
    }

    _updateLater() {
        if (this._idle || this._destroyed)
            return;
        this._idle = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._idle = 0;
            this._update();
            return GLib.SOURCE_REMOVE;
        });
    }

    _clearDockDelay() {
        if (this._delayTimer)
            GLib.Source.remove(this._delayTimer);
        this._delayTimer = 0;
    }

    _motionAllowed() {
        return !this._startupBusy() && this._settings.animationsEnabled && this._systemAnimations.enable_animations &&
            (!St.ReducedMotion || this._systemAnimations.reducedMotion !== St.ReducedMotion.REDUCE);
    }

    _update() {
        if (this._destroyed)
            return;
        const monitor = Main.layoutManager.primaryMonitor;
        const box = Main.layoutManager.panelBox;
        const fullscreen = Boolean(monitor?.inFullscreen);
        const enabled = this._settings.floatingPanel;
        const want = enabled && !this._covered();
        const was = this._floating;
        const motion = this._motionAllowed();
        // Ecrã inteiro: o próprio Shell esconde a barra. Não animar um actor escondido.
        if (!fullscreen && enabled && this._initialized && motion && was && !want && !this._dockReady) {
            this._delayTimer ||= GLib.timeout_add(GLib.PRIORITY_DEFAULT, DOCK_DELAY_MS, () => {
                this._delayTimer = 0;
                this._dockReady = true;
                try {
                    this._update();
                } finally {
                    this._dockReady = false;
                }
                return GLib.SOURCE_REMOVE;
            });
            return;
        }
        this._clearDockDelay();

        const top = this._settings.floatingPanelTop;
        const bottom = this._settings.floatingPanelBottom;
        const radius = this._settings.floatingPanelRadius;
        const key = `${radius}|${top}|${bottom}`;
        const newConfig = want && key !== this._floatKey;
        const animate = enabled && this._initialized && was !== want && motion && box?.visible &&
            !fullscreen && monitor?.width > 2 * MARGIN_SIDE;
        if (was !== want || newConfig) {
            const panel = this._panel;
            // Guarda o estado visual actual, incluindo uma transição invertida a meio.
            const old = animate && panel ? {
                x: (was ? MARGIN_SIDE : 0) + panel.translation_x,
                y: (was ? this._floatTop : 0) + panel.translation_y,
                width: (monitor.width - (was ? 2 * MARGIN_SIDE : 0)) * panel.scale_x,
            } : null;
            this._resetMotion();
            // A geometria, o CSS e o Blur são actualizados uma vez por mudança. Só a
            // transformação do painel é animada; não se escreve nas preferências a cada frame.
            if (want) {
                this._floatKey = key;
                this._floatTop = top;
                this._float(radius);
            } else {
                this._dock();
            }
            if (old && panel) {
                const endX = want ? MARGIN_SIDE : 0;
                const endY = want ? top : 0;
                const endW = monitor.width - 2 * endX;
                this._motionPivot = panel.get_pivot_point();
                panel.set_pivot_point(0, 0);
                panel.translation_x = old.x - endX;
                panel.translation_y = old.y - endY;
                panel.scale_x = old.width / endW;
                this._morphing = true;
                panel.ease({
                    translation_x: 0, translation_y: 0, scale_x: 1,
                    duration: Math.min(this._settings.animationDuration, MORPH_MAX_MS),
                    mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
                    onStopped: () => this._finishMotion(),
                });
            }
        } else if (fullscreen || !box?.visible || !motion) {
            this._resetMotion();
        }
        this._initialized = true;
    }

    _resetMotion() {
        const panel = this._panel;
        if (!panel || !this._morphing)
            return;
        this._morphing = false;
        for (const name of MORPH_PROPERTIES)
            panel.remove_transition(name);
        panel.set({translation_x: 0, translation_y: 0, scale_x: 1});
        this._finishMotion();
    }

    _finishMotion() {
        this._morphing = false;
        if (this._motionPivot)
            this._panel.set_pivot_point(...this._motionPivot);
        this._motionPivot = null;
    }

    _float(radius) {
        const panel = this._panel;
        const box = Main.layoutManager.panelBox;
        if (!panel)
            return;
        if (!this._saved) {
            this._saved = {
                style: panel.get_style?.() ?? null,
                boxStyle: box?.get_style?.() ?? null,
                corners: [panel._leftCorner, panel._rightCorner].map(c => c?.visible),
            };
        }
        // As margens do actor são ignoradas pelo painel no GNOME 51 (confirmado no journal); o
        // `padding` do contentor (panelBox) é respeitado pelo St e conta para a área de trabalho.
        box?.set_style(`${this._saved.boxStyle ?? ''} padding: ${this._settings.floatingPanelTop}px ${MARGIN_SIDE}px ${this._settings.floatingPanelBottom}px ${MARGIN_SIDE}px;`);
        panel.set_style(`${this._saved.style ?? ''} border-radius: ${radius}px;`);
        // Os cantos escuros do painel (se existirem) ficariam soltos à volta da barra flutuante.
        for (const corner of [panel._leftCorner, panel._rightCorner])
            corner?.hide();
        this._floating = true;
        this._alignBlurGroups();
        this._blurRound(radius);
        if (this._settings.debugLog)
            this._scheduleProbe(radius);
    }

    /**
     * O Blur my Shell desenha o fundo da barra (um rectângulo por baixo do painel) e tem o seu próprio
     * arredondamento: enquanto a barra flutua, o raio dele passa a ser o nosso e arredonda os 4 cantos
     * (rounded-corners: 0 = todos). Os valores originais guardam-se (também nas nossas definições,
     * para o caso de a sessão terminar a meio) e repõem-se ao deixar de flutuar.
     */
    _blurRound(radius) {
        let blur = null;
        try {
            blur = this._blur ?? this._openBlur();
        } catch (e) {
            console.error('[auto-tiler]', e);
        }
        if (!blur)
            return;
        this._blur = blur;
        if (!this._blurSaved) {
            const stale = this._settings.gsettings.get_string('floating-panel-bms-backup');
            const [r, c] = stale ? stale.split(',').map(Number) : [blur.get_int('corner-radius'), blur.get_int('rounded-corners')];
            this._blurSaved = {radius: r, corners: c};
            this._settings.gsettings.set_string('floating-panel-bms-backup', `${r},${c}`);
        }
        blur.set_int('corner-radius', radius);
        blur.set_int('rounded-corners', 0);
    }

    _blurRestore() {
        if (!this._blur || !this._blurSaved)
            return;
        try {
            this._blur.set_int('corner-radius', this._blurSaved.radius);
            this._blur.set_int('rounded-corners', this._blurSaved.corners);
            this._settings.gsettings.set_string('floating-panel-bms-backup', '');
        } catch (e) {
            console.error('[auto-tiler]', e);
        }
        this._blurSaved = null;
    }


    /** Diagnóstico (uma linha no journal): o que o painel fez de facto com as margens e o estilo. */
    _scheduleProbe(radius) {
        if (this._probe)
            GLib.Source.remove(this._probe);
        this._probe = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
            this._probe = 0;
            try {
                const p = this._panel;
                const box = a => {
                    const b = a?.get_allocation_box?.();
                    return b ? `${Math.round(b.x1)},${Math.round(b.y1)}..${Math.round(b.x2)},${Math.round(b.y2)}` : '?';
                };
                const monitor = Main.layoutManager.primaryMonitor;
                console.log(`[auto-tiler] barra flutuante: raio=${radius} caixa-estilo="${Main.layoutManager.panelBox?.get_style?.()}" ` +
                    `painel=${box(p)} pai=${p.get_parent?.()?.name}:${box(p.get_parent?.())} ` +
                    `monitor=${monitor?.x},${monitor?.y} ${monitor?.width}x${monitor?.height} ` +
                    `bms=${this._blur ? `${this._blur.get_int('corner-radius')}/${this._blur.get_int('rounded-corners')}` : '-'} ` +
                    `filhos=[${(Main.layoutManager.panelBox?.get_children?.() ?? []).map(c => `${c.get_name?.() ?? c.name}@${Math.round(c.x)},${Math.round(c.y)}+${Math.round(c.translation_x ?? 0)},${Math.round(c.translation_y ?? 0)}`).join(' ')}] ` +
                    `estilo="${p.get_style?.()}" classes="${p.get_style_class_name?.()}" visivel=${p.visible}`);
            } catch (e) {
                console.error('[auto-tiler]', e);
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _dock() {
        this._floating = false;
        this._alignBlurGroups(true);
        this._restore();
    }

    _restore() {
        const panel = this._panel;
        const saved = this._saved;
        if (!panel || !saved)
            return;
        this._blurRestore();
        panel.set_style(saved.style);
        Main.layoutManager.panelBox?.set_style(saved.boxStyle);
        [panel._leftCorner, panel._rightCorner].forEach((corner, i) => {
            if (corner && saved.corners[i])
                corner.show();
        });
        this._saved = null;
    }

    destroy() {
        this._destroyed = true;
        if (this._idle)
            GLib.Source.remove(this._idle);
        this._idle = 0;
        if (this._probe)
            GLib.Source.remove(this._probe);
        this._probe = 0;
        if (this._delayTimer)
            GLib.Source.remove(this._delayTimer);
        this._delayTimer = 0;
        for (const id of this._changedIds)
            this._settings.gsettings.disconnect(id);
        global.display.disconnect(this._fullscreenId);
        if (this._visibilityId)
            Main.layoutManager.panelBox.disconnect(this._visibilityId);
        this._systemAnimations.disconnect(this._systemAnimationsId);
        global.display.disconnect(this._createdId);
        global.display.disconnect(this._grabEndId);
        global.workspace_manager.disconnect(this._workspaceId);
        if (this._addedId)
            Main.layoutManager.panelBox.disconnect(this._addedId);
        for (const win of [...this._watched.keys()])
            this._unwatch(win);
        Main.layoutManager.disconnect(this._monitorsId);
        this._floating = false;
        this._resetMotion();
        this._alignBlurGroups(true);
        this._restore();
    }
}
