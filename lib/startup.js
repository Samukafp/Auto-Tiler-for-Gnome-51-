// Guardar uma janela curta de trabalho leve durante o arranque da sessão.
// Usa tempo monotónico e não rearma ao bloquear/desbloquear.
export const WARMUP_MS = 30_000;

export class StartupGuard {
    constructor(now, shellStarting) {
        this._now = now;
        this._shellStarting = shellStarting;
        this._until = now() + WARMUP_MS;
    }

    active() {
        return this._now() < this._until || this._shellStarting() === true;
    }
}
