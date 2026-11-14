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
        const want = desiredEffectsState({
            manage: this._settings.manageEffects,
            tilingEnabled: this._settings.tilingEnabled,
            fullscreen: this._isFullscreen(),
            inFullscreen: this._settings.effectsInFullscreen,
        });
        if (want === null) {
            this._applied.clear();
            return;
        }
        for (const uuid of this._settings.effectExtensions) {
            if (this._applied.get(uuid) === want)
                continue;
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
