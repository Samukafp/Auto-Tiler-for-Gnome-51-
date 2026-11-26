import {isFileChooser, isHandsOff} from './policy.js';

// O primeiro pedido do portal/GTK pode não ser o último. Tentativas limitadas à
// abertura; nunca perseguir a janela durante um arrasto ou depois de estar em uso.
const RETRY_MS = [100, 300, 650];
const MAX_W = 0.60;
const MAX_H = 0.70;
const EPSILON = 4;
const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

export function dialogTarget(frame, area, screen, {chooser, movable, resizable}) {
    if (!area || !frame || frame.width <= 0 || frame.height <= 0 || area.width <= 0 || area.height <= 0)
        return null;
    const limitW = Math.max(1, Math.round(area.width * MAX_W));
    const limitH = Math.max(1, Math.round(area.height * MAX_H));
    const width = resizable ? Math.min(frame.width, limitW) : frame.width;
    const height = resizable ? Math.min(frame.height, limitH) : frame.height;
    if (!chooser && width === frame.width && height === frame.height)
        return null;
    const centre = (chooser && screen) || area;
    const x = movable ? clamp(Math.round(centre.x + (centre.width - width) / 2),
        area.x, area.x + area.width - width) : frame.x;
    const y = movable ? clamp(Math.round(centre.y + (centre.height - height) / 2),
        area.y, area.y + area.height - height) : frame.y;
    if (Math.abs(frame.x - x) <= EPSILON && Math.abs(frame.y - y) <= EPSILON &&
        Math.abs(frame.width - width) <= EPSILON && Math.abs(frame.height - height) <= EPSILON)
        return null;
    return {x, y, width, height};
}

export class DialogPlacement {
    constructor(host) {
        this._host = host;
        this._seen = new WeakSet();
        this._pending = new Map();
    }

    ignore(win) {
        this._seen.add(win);
    }

    onMap(win) {
        if (this._seen.has(win))
            return;
        this._seen.add(win);
        try {
            if (win.is_override_redirect() || ![this._host.windowTypeNormal, ...this._host.dialogTypes].includes(win.get_window_type()))
                return;
            const entry = {source: 0, tries: 0, destroyId: 0, lastRequest: '', resizedAt: null};
            entry.destroyId = win.connect('unmanaging', () => this._stop(win));
            this._pending.set(win, entry);
            // Sair do sinal map antes de tentar move_resize_frame.
            entry.source = this._host.addIdle(() => this._apply(win, entry));
        } catch (e) {
            this._stop(win);
            this._host.logError(e);
        }
    }

    _apply(win, entry) {
        entry.source = 0;
        try {
            if (this._host.grabActive?.())
                return this._stop(win);
            if (!win.minimized && !isHandsOff(win)) {
                const parent = win.get_transient_for();
                const chooser = isFileChooser(win);
                if (chooser || parent) {
                    const winMonitor = win.get_monitor();
                    const parentMonitor = parent?.get_monitor() ?? -1;
                    const monitor = parentMonitor >= 0 ? parentMonitor : winMonitor;
                    if (monitor >= 0) {
                        const frame = win.get_frame_rect();
                        const area = win.get_work_area_for_monitor(monitor);
                        const screen = this._host.monitorGeometry?.(monitor);
                        const attached = win.is_attached_dialog();
                        // Se a app recusou o limite, centra o tamanho real em vez de o pedir
                        // indefinidamente. Se houve redimensionamento para maior desde o
                        // pedido, deixa o portal negociar um novo limite.
                        const resize = win.allows_resize() &&
                            (!entry.resizedAt || frame.width > entry.resizedAt.width + EPSILON ||
                                frame.height > entry.resizedAt.height + EPSILON);
                        const target = dialogTarget(frame, area, screen, {
                            chooser, movable: !attached && (chooser || win.allows_move()), resizable: resize,
                        });
                        if (target) {
                            const key = [frame.x, frame.y, frame.width, frame.height,
                                target.x, target.y, target.width, target.height].join(',');
                            if (key !== entry.lastRequest) {
                                entry.lastRequest = key;
                                if (frame.width !== target.width || frame.height !== target.height)
                                    entry.resizedAt = {width: frame.width, height: frame.height};
                                win.move_resize_frame(false, target.x, target.y, target.width, target.height);
                            }
                        }
                    }
                }
            }
            if (this._pending.get(win) !== entry)
                return;
            if (entry.tries < RETRY_MS.length) {
                const delay = RETRY_MS[entry.tries++];
                entry.source = this._host.addTimeout(delay, () => this._apply(win, entry));
            } else {
                this._stop(win);
            }
        } catch (e) {
            this._stop(win);
            this._host.logError(e);
        }
    }

    _stop(win) {
        const entry = this._pending.get(win);
        if (!entry)
            return;
        this._pending.delete(win);
        if (entry.source)
            this._host.removeTimeout(entry.source);
        try {
            win.disconnect(entry.destroyId);
        } catch {
            // Já foi fechada.
        }
    }

    destroy() {
        for (const win of this._pending.keys())
            this._stop(win);
    }
}
