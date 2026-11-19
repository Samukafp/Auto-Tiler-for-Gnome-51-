// Borda com gradiente animado na janela focada (opcional). Só lê a geometria da
// janela: nunca a altera, por isso não interfere com o tiling, a maximização nem o
// fullscreen.
//
// A borda só aparece quando a janela já está totalmente visível (acabou a animação
// de abrir/mover) e some logo que a janela começa a fechar.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {WallpaperColors} from './wallpaper-colors.js';
import {gradientAt, parseColor, perimeterPoints, phaseAt} from '../lib/border-path.js';

const FRAME_MS = 33;
// Tempo mínimo desde o 'map' da janela antes de mostrar a borda: cobre a animação de abrir do Shell.
const MAP_SETTLE_MS = 450;
const FADE_IN_MS = 320;
const MIRROR_PROPS = ['visible', 'opacity', 'scale-x', 'scale-y', 'translation-x', 'translation-y'];

export class FocusBorder {
    constructor(settings, isAnimating = () => false) {
        this._isAnimating = isAnimating;
        this._settings = settings;
        this._area = new St.DrawingArea({visible: false, reactive: false});
        this._area.connect('repaint', area => this._paint(area));
        this._win = null;
        this._actor = null;
        this._mapTimes = new Map(); // meta_window -> instante do 'map'
        this._fadeWins = new WeakSet(); // janelas novas: a 1.ª aparição da borda faz fade
        this._fading = false;
        this._settleSource = 0;
        this._winSignals = [];
        this._actorSignals = [];
        this._displaySignals = [];
        this._timerId = 0;
        this._guardId = 0;
        this._wallpaper = new WallpaperColors(() => this._update());
        this._points = null;
        this._pointsKey = '';

        global.window_group.add_child(this._area);
        this._listen(global.display, 'notify::focus-window', () => this._follow());
        // Menus e pop-ups da janela ficam POR CIMA dela: a borda tem de ficar logo acima da
        // janela e abaixo deles, também depois de qualquer reordenação das janelas.
        this._listen(global.display, 'restacked', () => this._restack());
        this._mapId = global.window_manager.connect('map', (_wm, actor) => {
            const meta = actor.meta_window;
            if (meta)
                this._mapTimes.set(meta, GLib.get_monotonic_time() / 1000);
            if (meta)
                this._fadeWins.add(meta); // a borda de uma janela nova aparece com fade
            // Apps pesadas (VS Code, editores de vídeo) fazem 'map' muito antes de pintar o
            // conteúdo: a contagem para mostrar a borda recomeça no primeiro frame desenhado.
            if (meta) {
                try {
                    const id = actor.connect('first-frame', () => {
                        actor.disconnect(id);
                        if (this._mapTimes.has(meta)) {
                            this._mapTimes.set(meta, GLib.get_monotonic_time() / 1000);
                            this._update();
                        }
                    });
                } catch {
                    // sem sinal 'first-frame': fica a contagem desde o map
                }
            }
            this._update();
        });
        this._listen(global.workspace_manager, 'workspace-switched', () => this._update());
        this._listen(Main.overview, 'showing', () => this._update());
        this._listen(Main.overview, 'hidden', () => this._update());
        this._changedId = settings.gsettings.connect('changed', () => this._update());
        this._follow();
    }

    _hideArea() {
        this._area.remove_all_transitions();
        this._fading = false;
        this._area.hide();
    }

    _listen(obj, name, handler) {
        this._displaySignals.push([obj, obj.connect(name, handler)]);
    }

    /**
     * Opacidade da borda: acompanha a janela nas animações NOSSAS; senão, a borda de uma
     * janela nova (ou, se escolhido, de qualquer foco novo) aparece de 0 a 100 %.
     */
    _applyOpacity(win, actor, wasVisible) {
        if (this._isAnimating(win)) {
            this._area.remove_all_transitions();
            this._fading = false;
            this._area.opacity = actor.opacity;
            return;
        }
        if (!wasVisible) {
            const fade = this._fadeWins.has(win) || this._settings.focusBorderFadeOnFocus;
            this._fadeWins.delete(win);
            if (fade) {
                this._area.opacity = 0;
                this._fading = true;
                this._area.ease({
                    opacity: 255,
                    duration: FADE_IN_MS,
                    mode: Clutter.AnimationMode.EASE_IN_OUT_QUAD,
                    onStopped: () => {
                        this._fading = false;
                    },
                });
                return;
            }
        }
        if (!this._fading)
            this._area.opacity = 255;
    }

    /** A janela está num workspace que está a ser mostrado agora? (senão a borda ficava "sozinha") */
    _onActiveWorkspace(win) {
        try {
            if (typeof win.showing_on_its_workspace === 'function' && !win.showing_on_its_workspace())
                return false;
            if (win.is_on_all_workspaces())
                return true;
            return win.get_workspace() === global.workspace_manager.get_active_workspace();
        } catch {
            return false;
        }
    }

    _restack() {
        try {
            if (this._area?.visible && this._actor)
                global.window_group.set_child_above_sibling(this._area, this._actor);
        } catch {
            // actor a ser destruído
        }
    }

    _follow() {
        this._unfollowWindow();
        const win = global.display.focus_window;
        if (win) {
            this._win = win;
            for (const name of ['position-changed', 'size-changed', 'notify::fullscreen',
                'notify::maximized-horizontally', 'notify::maximized-vertically', 'notify::minimized', 'workspace-changed'])
                this._winSignals.push(win.connect(name, () => this._update()));
            // A janela está a fechar: a borda desaparece já, não fica sozinha.
            this._winSignals.push(win.connect('unmanaging', () => {
                this._unfollowWindow();
                this._update();
            }));
            const actor = win.get_compositor_private();
            if (actor) {
                this._actor = actor;
                for (const prop of MIRROR_PROPS)
                    this._actorSignals.push(actor.connect(`notify::${prop}`, () => this._update()));
                this._actorSignals.push(actor.connect('destroy', () => {
                    this._actor = null;
                    this._actorSignals = [];
                    this._update();
                }));
            }
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
        if (this._actor) {
            for (const id of this._actorSignals) {
                try {
                    this._actor.disconnect(id);
                } catch {
                    // actor já destruído
                }
            }
        }
        this._winSignals = [];
        this._actorSignals = [];
        this._win = null;
        this._actor = null;
    }

    /**
     * Rectângulo da janela tal como se VÊ agora no ecrã: aplica ao rectângulo real a
     * translação e a escala (em torno do pivô) que o actor tem durante uma animação.
     */
    _visualRect(win, actor) {
        const frame = win.get_frame_rect();
        const sx = actor.scale_x;
        const sy = actor.scale_y;
        const tx = actor.translation_x;
        const ty = actor.translation_y;
        if (Math.abs(sx - 1) < 0.001 && Math.abs(sy - 1) < 0.001 && Math.abs(tx) < 0.5 && Math.abs(ty) < 0.5)
            return frame;
        const [px, py] = actor.get_pivot_point();
        const pvx = px * actor.width;
        const pvy = py * actor.height;
        const lx = frame.x - actor.x;
        const ly = frame.y - actor.y;
        return {
            x: actor.x + tx + pvx + (lx - pvx) * sx,
            y: actor.y + ty + pvy + (ly - pvy) * sy,
            width: frame.width * sx,
            height: frame.height * sy,
        };
    }

    /** A janela já terminou de animar (aparece inteira, sem escala nem deslocamento)? */
    _settled(actor) {
        return actor.visible && actor.opacity >= 255 &&
            Math.abs(actor.scale_x - 1) < 0.001 && Math.abs(actor.scale_y - 1) < 0.001 &&
            Math.abs(actor.translation_x) < 0.5 && Math.abs(actor.translation_y) < 0.5;
    }

    /** Milissegundos que faltam para a animação de abrir da janela terminar (0 = já terminou). */
    _settleRemaining(win) {
        const mapped = this._mapTimes.get(win);
        if (mapped === undefined)
            return 0;
        const left = MAP_SETTLE_MS - (GLib.get_monotonic_time() / 1000 - mapped);
        if (left <= 0) {
            this._mapTimes.delete(win);
            return 0;
        }
        return left;
    }

    _update() {
        const win = this._win;
        try {
            const left = win ? this._settleRemaining(win) : 0;
            if (left > 0) {
                // Janela a abrir: a borda espera, e volta a tentar quando a animação acabar.
                this._hideArea();
                this._stopTimer();
                if (!this._settleSource) {
                    this._settleSource = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.ceil(left) + 20, () => {
                        this._settleSource = 0;
                        this._update();
                        return GLib.SOURCE_REMOVE;
                    });
                }
                return;
            }
            const actor = this._actor;
            const show = this._settings.focusBorderEnabled &&
                !(this._settings.focusBorderHideWhenTilingOff && !this._settings.tilingEnabled) && win && actor && actor.visible && (this._settled(actor) || (this._isAnimating(win) && actor.opacity >= 255)) &&
                !Main.overview.visible && [Meta.WindowType.NORMAL, Meta.WindowType.DIALOG, Meta.WindowType.MODAL_DIALOG].includes(win.get_window_type()) &&
                !win.minimized && !win.is_fullscreen() && this._onActiveWorkspace(win) &&
                !win.maximized_horizontally && !win.maximized_vertically;
            if (!show) {
                this._hideArea();
                this._stopTimer();
                this._stopGuard();
                return;
            }
            const w = this._settings.focusBorderWidth;
            // A borda acompanha a janela DURANTE as animações (mesma posição, escala e
            // opacidade do actor): passa à frente / aparece / desvanece com ela.
            const rect = this._visualRect(win, actor);
            this._area.set_position(Math.round(rect.x - w), Math.round(rect.y - w));
            this._area.set_size(Math.max(1, Math.round(rect.width + 2 * w)), Math.max(1, Math.round(rect.height + 2 * w)));
            const wasVisible = this._area.visible;
            global.window_group.set_child_above_sibling(this._area, actor);
            this._area.show();
            this._applyOpacity(win, actor, wasVisible);
            this._area.queue_repaint();
            this._syncTimer();
            this._startGuard();
        } catch {
            this._hideArea();
            this._stopTimer();
        }
    }

    /** Cores efectivas: do wallpaper (se activado e disponível) ou as escolhidas à mão. */
    colors() {
        const wall = this._settings.focusBorderWallpaper ? this._wallpaper?.colors : null;
        return wall ?? {c1: this._settings.focusBorderColor, c2: this._settings.focusBorderColor2};
    }

    _syncTimer() {
        const {c1, c2} = this.colors();
        const animated = this._settings.focusBorderSpeed > 0 && c1 !== c2;
        if (!animated) {
            this._stopTimer();
            return;
        }
        if (this._timerId)
            return;
        this._timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, FRAME_MS, () => {
            if (!this._area || !this._area.visible) {
                this._timerId = 0;
                return GLib.SOURCE_REMOVE;
            }
            this._area.queue_repaint();
            return GLib.SOURCE_CONTINUE;
        });
    }

    /**
     * Guarda: enquanto a borda está visível, de segundo a segundo confirma que a janela
     * focada ainda é aquela e que continua visível. Se algum evento se perdeu, a borda
     * não pode ficar "sozinha" no ecrã.
     */
    _startGuard() {
        if (this._guardId)
            return;
        this._guardId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            if (!this._area?.visible) {
                this._guardId = 0;
                return GLib.SOURCE_REMOVE;
            }
            if (global.display.focus_window !== this._win)
                this._follow();
            else
                this._update();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopGuard() {
        if (this._guardId)
            GLib.Source.remove(this._guardId);
        this._guardId = 0;
    }

    _stopTimer() {
        if (this._timerId)
            GLib.Source.remove(this._timerId);
        this._timerId = 0;
    }

    _paint(area) {
        const cr = area.get_context();
        try {
            const [width, height] = area.get_surface_size();
            const lw = this._settings.focusBorderWidth;
            const radius = this._settings.focusBorderRadius + lw / 2;
            const key = `${width}x${height}:${lw}:${radius}`;
            if (key !== this._pointsKey) {
                this._points = perimeterPoints(width - lw, height - lw, radius);
                this._pointsKey = key;
            }
            const colors = this.colors();
            const c1 = parseColor(colors.c1);
            const c2 = parseColor(colors.c2);
            const phase = phaseAt(GLib.get_monotonic_time() / 1000, this._settings.focusBorderSpeed);
            const pts = this._points;
            const n = pts.length;

            cr.translate(lw / 2, lw / 2);
            cr.setLineWidth(lw);
            cr.setLineCap(1); // ROUND: sem emendas entre segmentos
            cr.setLineJoin(1);
            for (let i = 0; i < n; i++) {
                const a = pts[i];
                const b = pts[(i + 1) % n];
                const col = gradientAt(c1, c2, (i + 0.5) / n, phase);
                cr.setSourceRGBA(col.r, col.g, col.b, col.a);
                cr.moveTo(a.x, a.y);
                cr.lineTo(b.x, b.y);
                cr.stroke();
            }
        } catch (e) {
            console.error('[auto-tiler]', e);
        } finally {
            cr.$dispose();
        }
    }

    destroy() {
        this._stopTimer();
        this._stopGuard();
        if (this._settleSource)
            GLib.Source.remove(this._settleSource);
        this._settleSource = 0;
        if (this._mapId)
            global.window_manager.disconnect(this._mapId);
        this._mapId = 0;
        this._mapTimes.clear();
        this._wallpaper?.destroy();
        this._wallpaper = null;
        if (this._changedId)
            this._settings.gsettings.disconnect(this._changedId);
        this._changedId = 0;
        this._unfollowWindow();
        for (const [obj, id] of this._displaySignals) {
            try {
                obj.disconnect(id);
            } catch {
                // objecto já destruído
            }
        }
        this._displaySignals = [];
        this._area?.destroy();
        this._area = null;
    }
}
