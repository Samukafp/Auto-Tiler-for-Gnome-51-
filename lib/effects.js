// Gestão de extensões de efeitos (por omissão, as Compiz): desligadas com o tiling
// ligado (os efeitos "elásticos" competem com o tiling) e ligadas com o tiling
// desligado. Opcionalmente ligam-se enquanto há uma janela em fullscreen.
// Lógica pura: o `host` é quem fala com o gestor de extensões do Shell.

/**
 * @returns {boolean|null} true = efeitos ligados, false = desligados, null = não gerir.
 */
export function desiredEffectsState({manage, tilingEnabled, fullscreen, inFullscreen}) {
    if (!manage)
        return null;
    if (!tilingEnabled)
        return true;
    return Boolean(inFullscreen && fullscreen);
}

const OFF_DELAY_MS = 900; // deixa acabar a animação de sair de fullscreen antes de desligar os efeitos

export class EffectsController {
    /**
     * @param {object} host {isInstalled(uuid), setEnabled(uuid, bool), log, logError}
     * @param {object} settings TilerSettings (manageEffects, effectsInFullscreen, effectExtensions, tilingEnabled)
     * @param {() => boolean} isFullscreen
     */
    constructor(host, settings, isFullscreen) {
        this._host = host;
        this._settings = settings;
        this._isFullscreen = isFullscreen;
        this._applied = new Map(); // uuid -> último estado pedido
    }

    /** Recalcula e aplica o estado; só toca nas extensões cujo estado muda. */
    sync() {
        const inputs = {
            manage: this._settings.manageEffects,
            tilingEnabled: this._settings.tilingEnabled,
            fullscreen: this._isFullscreen(),
            inFullscreen: this._settings.effectsInFullscreen,
        };
        const want = desiredEffectsState(inputs);
        // Regista cada alteração das condições (para diagnóstico no journal).
        const key = JSON.stringify(inputs);
        if (key !== this._lastInputs) {
            this._lastInputs = key;
            this._host.log(`efeitos: condições ${key} -> ${want === null ? 'não gerir' : want ? 'ligar' : 'desligar'}`);
        }
        if (want === null) {
            this._applied.clear();
            return;
        }
        // Ao SAIR de fullscreen, os efeitos só se desligam depois da animação de saída do GNOME:
        // desligá-los a meio mostrava duas animações sobrepostas (imagem duplicada).
        if (want === true && this._pendingOff) {
            this._host.removeTimeout?.(this._pendingOff);
            this._pendingOff = 0;
        }
        const leaving = this._wasFullscreen && !inputs.fullscreen && want === false && inputs.tilingEnabled;
        this._wasFullscreen = inputs.fullscreen;
        if (leaving && !this._skipDelay && this._host.addTimeout) {
            if (!this._pendingOff) {
                this._pendingOff = this._host.addTimeout(OFF_DELAY_MS, () => {
                    this._pendingOff = 0;
                    this._skipDelay = true;
                    try {
                        this.sync();
                    } finally {
                        this._skipDelay = false;
                    }
                });
            }
            return;
        }
        if (want === false && this._pendingOff && !this._skipDelay)
            return; // a saída de fullscreen ainda está a decorrer
        for (const uuid of this._settings.effectExtensions) {
            // Estado real do Shell (se conhecido) ou, na falta dele, o último pedido.
            const actual = this._host.isEnabled?.(uuid);
            const current = actual === undefined ? this._applied.get(uuid) : actual;
            if (current === want) {
                this._applied.set(uuid, want);
                continue;
            }
            try {
                if (!this._host.isInstalled(uuid)) {
                    this._host.log(`extensão de efeitos ${uuid}: não está instalada, ignorada`);
                    this._applied.set(uuid, want);
                    continue;
                }
                this._host.setEnabled(uuid, want);
                this._applied.set(uuid, want);
                this._host.log(`extensão de efeitos ${uuid}: ${want ? 'ligada' : 'desligada'}`);
            } catch (e) {
                this._host.logError(e);
            }
        }
    }

    destroy() {
        if (this._pendingOff)
            this._host.removeTimeout?.(this._pendingOff);
        this._pendingOff = 0;
    }

    /** O utilizador desligou a extensão de tiling: o tiling deixa de existir, os efeitos voltam. */
    restore() {
        if (!this._settings.manageEffects)
            return;
        for (const uuid of this._settings.effectExtensions) {
            try {
                if (this._host.isInstalled(uuid))
                    this._host.setEnabled(uuid, true);
            } catch (e) {
                this._host.logError(e);
            }
        }
        this._applied.clear();
    }
}
