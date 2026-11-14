// Lê o wallpaper actual e calcula duas cores para a borda (ver lib/palette.js).
// Corre no Shell: usa GSettings do GNOME e GdkPixbuf para amostrar a imagem.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GdkPixbuf from 'gi://GdkPixbuf';

import {paletteFromColor, paletteFromPixels} from '../lib/palette.js';

export class WallpaperColors {
    /** @param {() => void} onChange chamado quando as cores mudam */
    constructor(onChange) {
        this._onChange = onChange;
        this.colors = null; // {c1, c2} | null
        this._cache = new Map();
        this._idle = 0;
        this._ids = [];
        this._bg = this._tryGSettings('org.gnome.desktop.background');
        this._iface = this._tryGSettings('org.gnome.desktop.interface');
        for (const [settings, keys] of [
            [this._bg, ['picture-uri', 'picture-uri-dark', 'primary-color', 'picture-options']],
            [this._iface, ['color-scheme']],
        ]) {
            if (!settings)
                continue;
            for (const key of keys)
                this._ids.push([settings, settings.connect(`changed::${key}`, () => this._schedule())]);
        }
        this._schedule();
    }

    _tryGSettings(schemaId) {
        try {
            return new Gio.Settings({schema_id: schemaId});
        } catch {
            return null;
        }
    }

    _schedule() {
        if (this._idle)
            return;
        this._idle = GLib.idle_add(GLib.PRIORITY_LOW, () => {
            this._idle = 0;
            this._refresh();
            return GLib.SOURCE_REMOVE;
        });
    }

    _refresh() {
        let colors = null;
        try {
            colors = this._compute();
        } catch (e) {
            console.error('[auto-tiler] wallpaper:', e);
        }
        if (colors?.c1 !== this.colors?.c1 || colors?.c2 !== this.colors?.c2) {
            this.colors = colors;
            this._onChange();
        }
    }

    _compute() {
        if (!this._bg)
            return null;
        const dark = this._iface?.get_string('color-scheme') === 'prefer-dark';
        const uri = (dark ? this._bg.get_string('picture-uri-dark') : '') || this._bg.get_string('picture-uri');
        const none = this._bg.get_string('picture-options') === 'none';
        if (!uri || none)
            return paletteFromColor(this._bg.get_string('primary-color'));

        if (this._cache.has(uri))
            return this._cache.get(uri);
        const path = Gio.File.new_for_uri(uri).get_path();
        let palette = null;
        // Imagens dinâmicas (.xml) não são amostradas: usa a cor primária.
        if (path && !path.endsWith('.xml')) {
            const pixbuf = GdkPixbuf.Pixbuf.new_from_file_at_scale(path, 96, 96, true);
            palette = paletteFromPixels({
                data: pixbuf.get_pixels(),
                width: pixbuf.get_width(),
                height: pixbuf.get_height(),
                channels: pixbuf.get_n_channels(),
                rowstride: pixbuf.get_rowstride(),
            });
        } else {
            palette = paletteFromColor(this._bg.get_string('primary-color'));
        }
        if (this._cache.size > 8)
            this._cache.clear();
        this._cache.set(uri, palette);
        return palette;
    }

    destroy() {
        if (this._idle)
            GLib.Source.remove(this._idle);
        this._idle = 0;
        for (const [settings, id] of this._ids)
            settings.disconnect(id);
        this._ids = [];
        this._onChange = () => {};
    }
}
