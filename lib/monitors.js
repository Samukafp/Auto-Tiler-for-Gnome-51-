// Monitores: área de trabalho de cada ecrã e notificação de alterações.

import {SignalManager} from './signals.js';

export class MonitorTracker {
    /**
     * @param {object} host Ver extension.js.
     * @param {Function} onChange Chamado quando monitores ou áreas de trabalho mudam.
     */
    constructor(host, onChange) {
        this._host = host;
        this._onChange = onChange;
        this._signals = new SignalManager();
    }

    enable() {
        this._signals.connect(this._host.layoutManager, 'monitors-changed', () => this._onChange());
        this._signals.connect(this._host.display, 'workareas-changed', () => this._onChange());
    }

    /** Índice do monitor onde a janela está, ou -1 se ainda não tiver um. */
    monitorOf(win) {
        return win.get_monitor();
    }

    /** Área útil (sem painel/dock) do monitor da janela. */
    workAreaOf(win) {
        const monitor = this.monitorOf(win);
        if (monitor < 0)
            return null;
        const r = win.get_work_area_for_monitor(monitor);
        return {x: r.x, y: r.y, width: r.width, height: r.height};
    }

    destroy() {
        this._signals.disconnectAll();
    }
}
