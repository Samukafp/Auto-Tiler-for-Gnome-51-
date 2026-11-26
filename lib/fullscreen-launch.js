// Only new windows that request fullscreen by their first frame. Never move a
// remapped or established window just because it enters fullscreen.
const WATCH_MS = 1000;

export class FullscreenLaunch {
    constructor(host, enabled) {
        this._host = host;
        this._enabled = enabled;
        this._pending = new Map();
    }

    watch(win, actor) {
        if (!this._enabled() || this._pending.has(win))
            return;
        try {
            if (win.get_transient_for() || win.is_on_all_workspaces())
                return;
            const entry = {
                source: win.get_workspace(), focus: this._host.display.focus_window,
                actor, frameId: 0, expiryId: 0, routeId: 0,
            };
            this._pending.set(win, entry);
            if (win.is_fullscreen()) {
                this.onFullscreen(win);
                return;
            }
            entry.frameId = actor.connect('first-frame', () => {
                if (!entry.routeId)
                    this.cancel(win);
            });
            // Safety for an actor without a paint: don't react to a later F11.
            entry.expiryId = this._host.addTimeout(WATCH_MS, () => {
                entry.expiryId = 0;
                if (!entry.routeId)
                    this.cancel(win);
            });
        } catch (e) {
            this.cancel(win);
            this._host.logError(e);
        }
    }

    onFullscreen(win) {
        const entry = this._pending.get(win);
        if (!entry || entry.routeId || !this._enabled() || !win.is_fullscreen())
            return;
        // Don't change workspaces from the map/fullscreen signal itself.
        entry.routeId = this._host.addIdle(() => {
            try {
                const source = win.get_workspace();
                if (this._enabled() && win.is_fullscreen() && !win.minimized &&
                    !win.get_transient_for() && !win.is_on_all_workspaces() &&
                    source && (!entry.source || source === entry.source) && !this._host.grabActive?.()) {
                    const focus = this._host.display.focus_window;
                    const follow = this._host.workspaceManager.get_active_workspace() === source &&
                        (focus === entry.focus || focus === win);
                    this._host.isolateFullscreenLaunch(win, source, follow);
                }
            } catch (e) {
                this._host.logError(e);
            } finally {
                entry.routeId = 0;
                this.cancel(win);
                this._host.onFullscreenLaunchSettled?.();
            }
        });
    }

    pending(win) {
        return Boolean(this._pending.get(win)?.routeId);
    }

    cancel(win) {
        const entry = this._pending.get(win);
        if (!entry)
            return;
        this._pending.delete(win);
        for (const id of [entry.routeId, entry.expiryId]) {
            if (id)
                this._host.removeTimeout(id);
        }
        if (entry.frameId) {
            try {
                entry.actor.disconnect(entry.frameId);
            } catch {
                // Actor já destruído.
            }
        }
    }

    destroy() {
        for (const win of this._pending.keys())
            this.cancel(win);
    }
}

/** Preserve other workspaces and reuse GNOME's trailing blank only in dynamic mode. */
export function moveToLaunchWorkspace({manager, win, source, follow, dynamic, timestamp}) {
    const lastIndex = manager.get_n_workspaces() - 1;
    const last = dynamic && lastIndex >= 0 ? manager.get_workspace_by_index(lastIndex) : null;
    const empty = last && last !== source && last !== manager.get_active_workspace() &&
        last.list_windows().every(w => w.is_on_all_workspaces());
    const target = empty ? last : manager.append_new_workspace(false, timestamp);
    if (!target || target === source)
        return false;
    win.change_workspace(target);
    if (win.get_workspace() !== target)
        return false;
    if (follow)
        target.activate_with_focus(win, timestamp);
    return true;
}
