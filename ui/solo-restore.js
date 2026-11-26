// Cover the intermediate, compositor-driven resize without freezing the client.
// Only the snapshot animates. The real window stays alive and receives frames.
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

const POLL_MS = 16;
const WAIT_MS = 192;
const MOTION_MS = 145;
const MAX_BUFFER_BORDER = 64; // CSD pode ganhar/perder margens invisíveis ao restaurar.
const EPSILON = 3;
const HOLD_OPACITY = 1;

export class SoloRestore {
    constructor(target) {
        this._target = target;
        this._entry = null;
    }

    begin(actor, oldRect) {
        this.cancel();
        const win = actor?.meta_window;
        const parent = actor?.get_parent?.();
        if (!win || !parent || parent !== global.window_group || !actor.mapped ||
            actor.opacity !== 255 || actor.get_transition('opacity') ||
            actor.scale_x !== 1 || actor.scale_y !== 1 || actor.translation_x || actor.translation_y ||
            !oldRect || oldRect.width <= 0 || oldRect.height <= 0)
            return;
        let snapshot;
        try {
            const content = actor.paint_to_content(oldRect);
            if (!content)
                return;
            const {x, y, width, height} = oldRect;
            snapshot = new St.Widget({content, reactive: false, x, y, width, height});
            snapshot.set_pivot_point(0, 0);
            const entry = {actor, win, snapshot, width, height, x, y, parent,
                source: 0, signals: [], dimmed: false, started: false,
                deadline: GLib.get_monotonic_time() + WAIT_MS * 1000};
            this._entry = entry;
            parent.insert_child_above(snapshot, actor);
            entry.signals.push([actor, actor.connect('destroy', () => this._finish(entry, true))]);
            for (const signal of ['notify::minimized', 'notify::fullscreen', 'workspace-changed', 'unmanaging'])
                entry.signals.push([win, win.connect(signal, () => this._finish(entry))]);
            entry.signals.push([global.workspace_manager, global.workspace_manager.connect('active-workspace-changed',
                () => this._finish(entry))]);
            entry.signals.push([global.display, global.display.connect('grab-op-begin', () => this._finish(entry))]);
            // Neither a zero-opacity actor nor a frozen actor is used here.
            entry.dimmed = true;
            actor.opacity = HOLD_OPACITY;
            entry.source = GLib.timeout_add(GLib.PRIORITY_DEFAULT, POLL_MS, () => this._tick(entry));
            return true;
        } catch (e) {
            if (this._entry)
                this._finish(this._entry);
            else
                snapshot?.destroy();
            console.error('[auto-tiler] animação ao restaurar:', e);
        }
    }

    _tick(entry) {
        try {
            const {actor, win, snapshot, parent} = entry;
            if (this._entry !== entry)
                return GLib.SOURCE_REMOVE;
            if (!actor.mapped || actor.get_parent() !== parent || actor.opacity !== HOLD_OPACITY ||
                (!entry.started && GLib.get_monotonic_time() >= entry.deadline)) {
                entry.source = 0;
                this._finish(entry);
                return GLib.SOURCE_REMOVE;
            }
            const target = this._target(win);
            const frame = win.get_frame_rect();
            const buffer = win.get_buffer_rect();
            const close = (a, b) => Math.abs(a - b) <= EPSILON;
            // On Wayland the requested frame can update before the client buffer.
            // Wait for both, and don't animate from an obsolete intermediate frame.
            const ready = target && close(frame.x, target.x) && close(frame.y, target.y) &&
                close(frame.width, target.width) && close(frame.height, target.height) &&
                close(actor.x, buffer.x) && close(actor.y, buffer.y) &&
                close(actor.get_width(), buffer.width) && close(actor.get_height(), buffer.height) &&
                buffer.width >= frame.width - EPSILON && buffer.height >= frame.height - EPSILON &&
                buffer.width <= frame.width + MAX_BUFFER_BORDER && buffer.height <= frame.height + MAX_BUFFER_BORDER;
            const key = ready ? [frame.x, frame.y, frame.width, frame.height, buffer.width, buffer.height].join(',') : null;
            const stable = key && key === entry.readyKey;
            entry.readyKey = key;
            if (!stable)
                return GLib.SOURCE_CONTINUE;

            entry.source = 0;
            if (close(frame.x, entry.x) && close(frame.y, entry.y) &&
                close(frame.width, entry.width) && close(frame.height, entry.height)) {
                this._finish(entry);
                return GLib.SOURCE_REMOVE;
            }
            entry.started = true;
            // Independent watchdog in case another extension interrupts the transition.
            entry.source = GLib.timeout_add(GLib.PRIORITY_DEFAULT, MOTION_MS + 90, () => {
                entry.source = 0;
                this._finish(entry);
                return GLib.SOURCE_REMOVE;
            });
            snapshot.ease({x: frame.x, y: frame.y, scale_x: frame.width / entry.width,
                scale_y: frame.height / entry.height, duration: MOTION_MS,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC, onStopped: () => this._finish(entry)});
        } catch (e) {
            console.error('[auto-tiler] animação ao restaurar:', e);
            // This callback is already ending; only remove a separate watchdog.
            if (!entry.started)
                entry.source = 0;
            this._finish(entry);
        }
        return GLib.SOURCE_REMOVE;
    }

    _finish(entry, actorGone = false) {
        if (this._entry !== entry)
            return;
        this._entry = null;
        if (entry.source)
            GLib.Source.remove(entry.source);
        entry.source = 0;
        for (const [object, id] of entry.signals) {
            try {
                object.disconnect(id);
            } catch {
                // Already disposed.
            }
        }
        try {
            if (!actorGone && entry.dimmed && entry.actor.opacity === HOLD_OPACITY)
                entry.actor.opacity = 255;
        } finally {
            entry.snapshot.destroy();
        }
    }

    cancel() {
        if (this._entry)
            this._finish(this._entry);
    }
}
