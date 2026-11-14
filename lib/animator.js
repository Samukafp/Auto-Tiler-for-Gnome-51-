// Política de animações do tiling. Decide SE e QUANTO animar; a animação em si
// (transformação do actor da janela) é feita pelo `host`, em extension.js.
//
// Princípios:
//  - A geometria real da janela muda logo para o valor final; a animação é só
//    visual (o actor parte do aspecto antigo e converge para o novo), por isso
//    nunca há conflito com a posição real.
//  - Curta (180 ms por omissão, configurável) e com poucas janelas em simultâneo.
//  - Desligada se o utilizador a desligou ou se o GNOME tem animações desligadas
//    / movimento reduzido.

export const DURATION_MS = 180;
export const MAX_SIMULTANEOUS = 8;
const MIN_DELTA_PX = 3;

function isTiny(from, to) {
    return Math.abs(from.x - to.x) < MIN_DELTA_PX &&
        Math.abs(from.y - to.y) < MIN_DELTA_PX &&
        Math.abs(from.width - to.width) < MIN_DELTA_PX &&
        Math.abs(from.height - to.height) < MIN_DELTA_PX;
}

export class Animator {
    constructor(host, settings) {
        this._host = host;
        this._settings = settings;
    }

    /** @param {{rec:object, from:object, to:object}[]} moves */
    play(moves) {
        if (!this._settings.animationsEnabled || !this._host.animationsAllowed())
            return;

        let started = 0;
        for (const {rec, from, to} of moves) {
            if (started >= MAX_SIMULTANEOUS)
                break;
            if (isTiny(from, to))
                continue;
            try {
                this._host.animateWindow(rec.win, from, to, this._settings.animationDuration ?? DURATION_MS);
                started++;
            } catch (e) {
                this._host.logError(e);
            }
        }
    }

    /** Pára a animação de uma janela e repõe o seu aspecto normal. */
    cancel(win) {
        try {
            this._host.cancelAnimation(win);
        } catch (e) {
            this._host.logError(e);
        }
    }

    destroy() {
        try {
            this._host.cancelAllAnimations();
        } catch (e) {
            this._host.logError(e);
        }
    }
}
