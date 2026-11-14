// Borda com gradiente animado na janela focada (opcional). Só lê a geometria da
// janela: nunca a altera, por isso não interfere com o tiling, a maximização nem o
// fullscreen.
//
// A borda só aparece quando a janela já está totalmente visível (acabou a animação
// de abrir/mover) e some logo que a janela começa a fechar.

import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {WallpaperColors} from './wallpaper-colors.js';
import {gradientAt, parseColor, perimeterPoints, phaseAt} from '../lib/border-path.js';

const FRAME_MS = 33;
const MIRROR_PROPS = ['visible', 'opacity', 'scale-x', 'scale-y', 'translation-x', 'translation-y'];

export class FocusBorder {
    constructor(settings) {
        this._settings = settings;
        this._area = new St.DrawingArea({visible: false, reactive: false});
        this._area.connect('repaint', area => this._paint(area));
        this._win = null;
        this._actor = null;
        this._winSignals = [];
        this._actorSignals = [];
        this._displaySignals = [];
        this._timerId = 0;
        this._wallpaper = new WallpaperColors(() => this._update());
        this._points = null;
        this._pointsKey = '';

        global.window_group.add_child(this._area);
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

    /** A janela já terminou de animar (aparece inteira, sem escala nem deslocamento)? */
    _settled(actor) {
        return actor.visible && actor.opacity >= 255 &&
            Math.abs(actor.scale_x - 1) < 0.001 && Math.abs(actor.scale_y - 1) < 0.001 &&
            Math.abs(actor.translation_x) < 0.5 && Math.abs(actor.translation_y) < 0.5;
    }

    _update() {
        const win = this._win;
        try {
            const actor = this._actor;
            const show = this._settings.focusBorderEnabled && win && actor && this._settled(actor) &&
                !Main.overview.visible && win.get_window_type() === Meta.WindowType.NORMAL &&
                !win.minimized && !win.is_fullscreen() &&
                !win.maximized_horizontally && !win.maximized_vertically;
            if (!show) {
                this._area.hide();
                this._stopTimer();
                return;
            }
            const w = this._settings.focusBorderWidth;
            const rect = win.get_frame_rect();
            this._area.set_position(rect.x - w, rect.y - w);
            this._area.set_size(rect.width + 2 * w, rect.height + 2 * w);
            global.window_group.set_child_above_sibling(this._area, actor);
            this._area.show();
            this._area.queue_repaint();
            this._syncTimer();
        } catch {
            this._area.hide();
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
        this._wallpaper?.destroy();
        this._wallpaper = null;
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
        this._area?.destroy();
        this._area = null;
    }
}
