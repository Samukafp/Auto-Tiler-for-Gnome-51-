// Leitura tipada das preferências (Gio.Settings) e notificação de alterações.

import {SignalManager} from './signals.js';

export class TilerSettings {
    /** @param {Gio.Settings} gsettings */
    constructor(gsettings) {
        this._gsettings = gsettings;
        this._signals = new SignalManager();
    }

    get tilingEnabled() {
        return this._gsettings.get_boolean('tiling-enabled');
    }

    set tilingEnabled(value) {
        this._gsettings.set_boolean('tiling-enabled', value);
    }

    get innerGap() {
        return this._gsettings.get_boolean('gaps-enabled')
            ? this._gsettings.get_int('inner-gap') : 0;
    }

    get outerGap() {
        return this._gsettings.get_boolean('gaps-enabled')
            ? this._gsettings.get_int('outer-gap') : 0;
    }

    get defaultRatio() {
        return this._gsettings.get_double('default-ratio');
    }

    get floatClasses() {
        return this._gsettings.get_strv('float-wm-classes').map(c => c.trim().toLowerCase());
    }

    /** Largura (% da área útil) das janelas "de tamanho normal" 16:10. */
    get normalWindowSize() {
        return Math.max(25, Math.min(70, this._gsettings.get_int('normal-window-size')));
    }

    get tileVideoPlayers() {
        return this._gsettings.get_boolean('tile-video-players');
    }

    get limitEnabled() {
        return this._gsettings.get_boolean('limit-enabled');
    }

    /** Limite efectivo por workspace; sem limite devolve um valor inalcançável. */
    get maxWindows() {
        if (!this.limitEnabled)
            return 1000;
        return Math.max(1, this._gsettings.get_int('max-windows'));
    }

    get swapOnDrag() {
        return this._gsettings.get_boolean('swap-on-drag');
    }

    get animationsEnabled() {
        return this._gsettings.get_boolean('animations-enabled');
    }

    /** Altura (px) da faixa inferior livre para a dock; 0 se a opção estiver desligada. */
    get dockReserve() {
        return this.dockReserveEnabled ? Math.max(0, this._gsettings.get_int('dock-reserve-size')) : 0;
    }

    get dockReserveEnabled() {
        return this._gsettings.get_boolean('dock-reserve');
    }

    get dockReserveMargin() {
        return Math.max(0, this._gsettings.get_int('dock-reserve-margin'));
    }

    get dockReserveAuto() {
        return this._gsettings.get_boolean('dock-reserve-auto');
    }

    get debugLog() {
        return this._gsettings.get_boolean('debug-log');
    }

    get hideUntilSized() {
        return this._gsettings.get_boolean('hide-until-sized');
    }

    get animateOpen() {
        return this._gsettings.get_boolean('animate-open');
    }

    get fastUnmaximize() {
        return this._gsettings.get_boolean('fast-unmaximize');
    }

    get focusResizeEnabled() {
        return this._gsettings.get_boolean('focus-resize-enabled');
    }

    get focusResizeMin() {
        return Math.max(1, this._gsettings.get_int('focus-resize-min'));
    }

    get focusResizeMax() {
        return Math.max(this.focusResizeMin, this._gsettings.get_int('focus-resize-max'));
    }

    get manageEffects() {
        return this._gsettings.get_boolean('manage-effect-extensions');
    }

    get effectsInFullscreen() {
        return this._gsettings.get_boolean('effects-in-fullscreen');
    }

    get effectExtensions() {
        return this._gsettings.get_strv('effect-extensions').map(u => u.trim()).filter(Boolean);
    }

    get animationDuration() {
        return Math.max(50, Math.min(600, this._gsettings.get_int('animation-duration')));
    }

    get openFadeDuration() {
        return Math.max(100, Math.min(1500, this._gsettings.get_int('open-fade-duration')));
    }

    get focusBorderFadeDuration() {
        return Math.max(80, Math.min(1000, this._gsettings.get_int('focus-border-fade-duration')));
    }

    /** 'right' (omissão): as janelas novas entram à direita; 'left': à esquerda. */
    get openSide() {
        return this._gsettings.get_string('open-side') === 'left' ? 'left' : 'right';
    }

    get workspaceNumbers() {
        return this._gsettings.get_boolean('workspace-numbers');
    }

    get floatingOnTop() {
        return this._gsettings.get_boolean('floating-on-top');
    }

    get smartGaps() {
        return this._gsettings.get_boolean('smart-gaps');
    }

    get showRestoreButton() {
        return this._gsettings.get_boolean('show-restore-button');
    }

    get unmaximizeOnOpen() {
        return this._gsettings.get_boolean('unmaximize-on-open');
    }

    get workspaceNumbersStyle() {
        return this._gsettings.get_string('workspace-numbers-style');
    }

    get focusBorderSlide() {
        return this._gsettings.get_boolean('focus-border-slide');
    }

    get focusBorderSlideDuration() {
        return Math.max(80, Math.min(800, this._gsettings.get_int('focus-border-slide-duration')));
    }

    get focusBorderFadeOnFocus() {
        return this._gsettings.get_boolean('focus-border-fade-on-focus');
    }

    get focusBorderHideWhenTilingOff() {
        return this._gsettings.get_boolean('focus-border-hide-when-tiling-off');
    }

    get focusBorderEnabled() {
        return this._gsettings.get_boolean('focus-border-enabled');
    }

    get focusBorderWidth() {
        return this._gsettings.get_int('focus-border-width');
    }

    get focusBorderRadius() {
        return this._gsettings.get_int('focus-border-radius');
    }

    /** Só aceita #rrggbb / #rrggbbaa; qualquer outra coisa cai na cor por omissão. */
    get focusBorderColor() {
        const value = this._gsettings.get_string('focus-border-color').trim();
        return /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(value) ? value : '#33d17a';
    }

    get focusBorderWallpaper() {
        return this._gsettings.get_boolean('focus-border-wallpaper');
    }

    get focusBorderColor2() {
        const value = this._gsettings.get_string('focus-border-color2').trim();
        return /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(value) ? value : '#3584e4';
    }

    /** 0 (parado) a 10. */
    get focusBorderSpeed() {
        return Math.max(0, Math.min(10, this._gsettings.get_int('focus-border-speed')));
    }

    /** Instantâneo imutável usado por uma passagem de layout. */
    snapshot() {
        return {
            innerGap: this.innerGap,
            outerGap: this.outerGap,
            smartGaps: this.smartGaps,
            defaultRatio: this.defaultRatio,
            floatClasses: this.floatClasses,
            tileVideoPlayers: this.tileVideoPlayers,
        };
    }

    onChanged(callback) {
        this._signals.connect(this._gsettings, 'changed', (_s, key) => callback(key));
    }

    get gsettings() {
        return this._gsettings;
    }

    destroy() {
        this._signals.disconnectAll();
    }
}
