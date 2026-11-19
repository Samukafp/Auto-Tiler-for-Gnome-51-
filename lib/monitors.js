// Monitores: área de trabalho de cada ecrã e notificação de alterações.

import {SignalManager} from './signals.js';

export class MonitorTracker {
    /**
     * @param {object} host Ver extension.js.
     * @param {Function} onChange Chamado quando monitores ou áreas de trabalho mudam.
     */
    constructor(host, onChange, dockReserve = () => 0) {
        this._host = host;
        this._dockReserve = dockReserve;
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
        // Faixa inferior livre para a dock (nunca deixa a área com menos de metade da altura).
        const reserve = Math.min(Math.max(0, this._dockReserve() || 0), Math.floor(r.height / 2));
        return {x: r.x, y: r.y, width: r.width, height: r.height - reserve};
    }

    destroy() {
        this._signals.disconnectAll();
    }
}
