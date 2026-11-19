// Política de animações do tiling. Decide SE e QUANTO animar; a animação em si
// (transformação do actor da janela) é feita pelo `host`, em extension.js.
//
// Princípios:
//  - A geometria real da janela muda logo para o valor final; a animação é só
//    visual (o actor parte do aspecto antigo e converge para o novo), por isso
//    nunca há conflito com a posição real.
//  - Curta (320 ms por omissão, configurável) e com poucas janelas em simultâneo.
//  - Desligada se o utilizador a desligou ou se o GNOME tem animações desligadas
//    / movimento reduzido.

export const FADE_OPACITY = 185;
export const DURATION_MS = 320;
export const MAX_SIMULTANEOUS = 8;
export const APPEAR_SCALE = 0.92;
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
    /**
     * Janela que "aparece" no sítio final (ex.: trazida por cima de um fullscreen): parte
     * um pouco mais pequena e totalmente transparente e cresce/ganha opacidade até ao lugar.
     */
    appear(rec, to, durationScale = 1.5, origin = null, wait = false, fadeOnly = false, instant = false) {
        // 'instant': sem fade visível (animações/abertura desligadas), mas a janela continua escondida
        // até ter o tamanho certo.
        if (!instant && (!this._settings.animationsEnabled || !this._host.animationsAllowed()))
            return false;
        // Parte de onde a janela está agora e vai até ao destino (se já lá está, cresce do centro).
        const near = origin && Math.abs(origin.x - to.x) < 24 && Math.abs(origin.y - to.y) < 24 &&
            Math.abs(origin.width - to.width) < 24 && Math.abs(origin.height - to.height) < 24;
        const k = APPEAR_SCALE;
        const from = fadeOnly ? {...to} : origin && !near ? {...origin} : {
            x: to.x + to.width * (1 - k) / 2,
            y: to.y + to.height * (1 - k) / 2,
            width: to.width * k,
            height: to.height * k,
        };
        try {
            this._host.animateWindow(rec.win, from, to,
                instant ? 1 : Math.round((this._settings.animationDuration ?? DURATION_MS) * durationScale), 0, true, wait);
            return true;
        } catch (e) {
            this._host.logError(e);
            return false;
        }
    }

    /**
     * A animação de "aparecer" ao contrário: a janela vai de onde está até ao slot e desvanece.
     * @returns {number} duração em ms (0 se não houve animação)
     */
    disappear(rec, from, to, durationScale = 1.5) {
        if (!this._settings.animationsEnabled || !this._host.animationsAllowed())
            return 0;
        const ms = Math.round((this._settings.animationDuration ?? DURATION_MS) * durationScale);
        try {
            this._host.animateWindow(rec.win, from, to, ms, 'out', true, true);
            return ms;
        } catch (e) {
            this._host.logError(e);
            return 0;
        }
    }

    play(moves, {fade = false, durationScale = 1, soft = false, noFade = false, wait = false} = {}) {
        if (!this._settings.animationsEnabled || !this._host.animationsAllowed())
            return;

        let started = 0;
        for (const {rec, from, to} of moves) {
            if (started >= MAX_SIMULTANEOUS)
                break;
            if (isTiny(from, to))
                continue;
            // Mudança grande de tamanho: o cliente só redesenha depois; um fade ligeiro disfarça o corte.
            const big = Math.abs(from.width - to.width) > to.width * 0.12 ||
                Math.abs(from.height - to.height) > to.height * 0.12;
            try {
                // Se o tamanho muda, o actor ainda mostra o tamanho antigo até a app redesenhar:
                // a transformação só pode arrancar quando ele já mostra o novo (senão a janela
                // aparece esticada, ex.: escala 2x). Só mudar de sítio não precisa de esperar.
                const resizes = Math.abs(from.width - to.width) > 2 || Math.abs(from.height - to.height) > 2;
                this._host.animateWindow(rec.win, from, to,
                    Math.round((this._settings.animationDuration ?? DURATION_MS) * durationScale),
                    fade || (big && !noFade ? FADE_OPACITY : false), soft, wait || resizes);
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
