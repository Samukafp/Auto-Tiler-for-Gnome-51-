// Marca do destino ao arrastar uma janela em tiling para cima de outra (troca de
// lugares), como no COSMIC: um rectângulo translúcido sobre o slot que a janela
// vai ocupar se for largada. Só desenha; não toca em janelas.

import Clutter from 'gi://Clutter';
import St from 'gi://St';

import {parseColor} from '../lib/border-path.js';

export class DropHint {
    /** @param {() => {c1: string}} getColors cores efectivas da borda (para combinar) */
    constructor(settings, getColors) {
        this._settings = settings;
        this._getColors = getColors;
        this._widget = new St.Widget({visible: false, reactive: false, opacity: 0});
        global.window_group.add_child(this._widget);
    }

    show(rect) {
        const widget = this._widget;
        if (!widget)
            return;
        const col = parseColor(this._getColors().c1);
        const rgba = a => `rgba(${Math.round(col.r * 255)}, ${Math.round(col.g * 255)}, ${Math.round(col.b * 255)}, ${a})`;
        const radius = this._settings.focusBorderRadius;
        widget.set_style(`background-color: ${rgba(0.22)}; border: 3px solid ${rgba(0.9)}; ` +
            `border-radius: ${radius}px;`);
        global.window_group.set_child_above_sibling(widget, null);

        if (!widget.visible) {
            // Primeira vez: aparece já no sítio, a ganhar opacidade.
            widget.set_position(rect.x, rect.y);
            widget.set_size(rect.width, rect.height);
            widget.opacity = 0;
            widget.show();
        }
        widget.remove_all_transitions();
        widget.ease({
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
            opacity: 255,
            duration: 140,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    hide() {
        const widget = this._widget;
        if (!widget || !widget.visible)
            return;
        widget.remove_all_transitions();
        widget.ease({
            opacity: 0,
            duration: 100,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onStopped: () => widget.hide(),
        });
    }

    destroy() {
        this._widget?.remove_all_transitions();
        this._widget?.destroy();
        this._widget = null;
    }
}
