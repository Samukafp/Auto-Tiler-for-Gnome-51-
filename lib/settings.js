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

    get maxWindows() {
        return Math.max(1, this._gsettings.get_int('max-windows'));
    }

    get swapOnDrag() {
        return this._gsettings.get_boolean('swap-on-drag');
    }

    get animationsEnabled() {
        return this._gsettings.get_boolean('animations-enabled');
    }

    get unmaximizeOnOpen() {
        return this._gsettings.get_boolean('unmaximize-on-open');
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

    /** Instantâneo imutável usado por uma passagem de layout. */
    snapshot() {
        return {
            innerGap: this.innerGap,
            outerGap: this.outerGap,
            defaultRatio: this.defaultRatio,
            floatClasses: this.floatClasses,
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
