// Coordenação geral: regista janelas, escuta o GNOME e agenda passagens de layout.
//
// Princípios que evitam conflitos com maximização e fullscreen:
//  1. O estado da janela é lido, nunca imposto. Janelas maximizadas ou em
//     fullscreen mantêm o seu lugar lógico no layout, mas a extensão nunca lhes
//     aplica geometria. (Única excepção, opcional: uma janela NOVA que abre
//     maximizada é desmaximizada uma vez, no instante em que abre.)
//  2. Fora de um arrasto, o único size-changed escutado é o de convergência de janelas
//     NOVAS (primeiros segundos, máx. 10 pedidos, sempre adiado, nunca dentro do sinal).
//  3. Todas as reacções passam por uma passagem de layout agendada e idempotente.
//  4. Durante um arrasto, só as janelas vizinhas são ajustadas; a arrastada é
//     do utilizador.

import {Animator} from './animator.js';
import {FloatingPolicy} from './floating.js';
import {sameRect} from './layout.js';
import {MonitorTracker} from './monitors.js';
import {pickWorkspace} from './overflow.js';
import {centredFrame, needsCascade, restoreFrame, spreadSlot} from './geometry.js';
import {isHandsOff, isManageable, isOverlay} from './policy.js';
import {SignalManager} from './signals.js';
import {TilingEngine} from './tiling.js';
import {buildGroups} from './workspace.js';

const DEBOUNCE_MS = 24;
const LIVE_MS = 12;
const VERIFY_MS = 150;
const VERIFY_SETTLE_MS = 600; // apps lentas (a seguir a uma suspensão) demoram a aplicar o tamanho
const RESIZE_TOLERANCE = 2;
const HOLD_ABOVE_MS = 800; // regresso ao slot: tempo que as janelas trazidas ficam à frente
const UNDER_RETRY_MS = 300; // janela mais pequena do que o pedido (app ainda a arrancar): repete o pedido
const UNDER_RETRIES = 20;
const CONVERGE_MS = 8000; // janela nova: reage ao PRÓPRIO size-changed da app e repõe o alvo
const CONVERGE_DELAY_MS = 60;
const CONVERGE_TRIES = 10;
const RECENT_MS = 8000; // janelas assim novas continuam a ser vigiadas (a app pode redimensionar-se sozinha)
// Janela "escondida" à espera de abrir: opacidade 1/255 e NÃO 0. Com 0 o Clutter nem a pinta, o
// Mutter não envia 'frame callbacks' e a app não redesenha ao novo tamanho (ficava a 90% ate ao fim da espera).
const HIDDEN_OPACITY = 1;
const OPEN_AWAIT_MS = 500; // aberturas: tempo máximo à espera de a janela ter lugar no tiling

// Alterações de estado que obrigam a recalcular o layout.
const OPEN_GRACE_MS = 2500;   // fase de abertura em que "maximizada" é estado lembrado pela app
const LATE_UNMAX_DELAY_MS = 30;
const MOVE_THRESHOLD = 24;   // px: abaixo disto, soltar a janela não conta como "arrastar"
const MAX_OPEN_UNMAX = 2;
const MIN_VISIBLE_PX = 40;
const LATE_LAYOUT_MS = [1500, 1500, 3000, 4000, 5000, 10000]; // acumulam-se: 1,5 s ... ~25 s
const FRESH_MS = 1000; // janela acabada de mapear: conta como visível     // janelas mais pequenas do que isto não ocupam um slot

const WINDOW_SIGNALS = [
    'notify::maximized-horizontally',
    'notify::maximized-vertically',
    'notify::fullscreen',
    'workspace-changed',
];

export class WindowManager {
    /**
     * @param {object} host Fronteira com o GNOME Shell (ver extension.js).
     * @param {import('./settings.js').TilerSettings} settings
     */
    constructor(host, settings) {
        this._host = host;
        this._settings = settings;
        this._signals = new SignalManager();
        this._monitors = new MonitorTracker(host, () => this.scheduleLayout(), () => this._dockReserve());
        this._floating = new FloatingPolicy();
        this._engine = new TilingEngine(message => this._host.log(message));
        this._animator = new Animator(host, settings);

        this._records = new Map();
        this._seq = 0;
        this._source = 0;
        this._liveSource = 0;
        this._verifySource = 0;
        this._underSource = 0;
        this._releaseVerifySource = 0;
        this._inLayout = false;
        this._grab = null;
        this._pendingLearn = null;
        this._enabled = false;
        this._listeners = new Set();
        this._lastState = {manualChanges: false, fullscreen: false, brought: false};
        this._focusSource = 0;
        this._hintSource = 0;
        this._hintShown = false;
        this._lateSource = 0;
    }

    /** Ids das janelas por ordem de antiguidade (para sobreviver a bloquear/suspender). */
    exportOrder() {
        return [...this._records.values()].sort((a, b) => a.seq - b.seq).map(rec => rec.id);
    }

    enable(savedOrder = []) {
        if (this._enabled)
            return;
        this._enabled = true;
        this._unwatchDock = this._host.watchDock?.(() => this._onDockChanged()) ?? null;

        const {display, shellWm, workspaceManager} = this._host;
        this._signals.connect(display, 'window-created', (_d, win) => {
            if (this._register(win))
                this.scheduleLayout();
        });
        // 'map' dá-nos a janela antes da primeira pintura: layout imediato, sem flicker.
        this._signals.connect(shellWm, 'map', (_wm, actor) => this._onMap(actor));
        this._signals.connect(display, 'notify::focus-window', () => this._scheduleFocus());
        this._signals.connect(display, 'grab-op-begin', (_d, win) => this._onGrabBegin(win));
        this._signals.connect(display, 'grab-op-end', () => this._onGrabEnd());
        this._signals.connect(workspaceManager, 'active-workspace-changed', () => {
            this.scheduleLayout();
            this._notifyState();
        });
        for (const name of ['workspace-added', 'workspace-removed'])
            this._signals.connect(workspaceManager, name, () => this.scheduleLayout());

        this._monitors.enable();
        this._settings.onChanged(key => this._onSettingChanged(key));

        // Janelas que já existiam não são "novas": a política de abertura não lhes toca.
        // Ao desbloquear o ecrã o GNOME desactiva e volta a activar a extensão: a ordem
        // que as janelas tinham é reposta (senão ficavam pela ordem de empilhamento).
        const rank = new Map(savedOrder.map((id, i) => [id, i]));
        const known = this._host.listWindows().map((win, i) => ({win, i, rank: rank.get(win.get_id()) ?? Infinity}));
        known.sort((a, b) => (a.rank === b.rank ? a.i - b.i : a.rank - b.rank));
        for (const {win} of known)
            this._register(win, {existing: true});
        this.layoutNow();
        this._scheduleLateLayouts(); // ao desbloquear, apps lentas ainda se ajustam durante segundos
    }

    /** Desliga tudo. Não altera o estado de nenhuma janela. */
    destroy() {
        this._enabled = false;
        for (const key of ['_source', '_liveSource', '_verifySource', '_releaseVerifySource', '_focusSource', '_hintSource', '_lateSource', '_underSource']) {
            if (this[key]) {
                this._host.removeTimeout(this[key]);
                this[key] = 0;
            }
        }
        this._hideHint();
        this._unwatchDock?.();
        this._unwatchDock = null;
        if (this._dockTimer)
            this._host.removeTimeout(this._dockTimer);
        this._dockTimer = 0;
        for (const rec of this._records.values()) {
            if (rec.convSource) {
                this._host.removeTimeout(rec.convSource);
                rec.convSource = 0;
            }
            if (rec.openAwait) {
                this._endOpenAwait(rec, true); // nunca deixa uma janela invisível
            }
        }
        this._dropAllAbove();
        this._signals.disconnectAll();
        this._monitors.destroy();
        this._animator.destroy();
        this._records.clear();
        this._grab = null;
        this._pendingLearn = null;
        this._listeners.clear();
    }

    // ---- Interface para a UI (topbar, Quick Settings) --------------------

    /** Há proporções ajustadas à mão no workspace activo? */
    hasManualChanges() {
        const active = this._activeWorkspaceIndex();
        const config = this._settings.snapshot();
        for (const rec of this._records.values()) {
            try {
                if (rec.manual && this._workspaceOf(rec) === active && this._inTiling(rec, config))
                    return true;
            } catch (e) {
                this._host.logError(e);
            }
        }
        return false;
    }

    /** Há alguma janela em fullscreen (visível) no workspace activo? */
    hasFullscreen() {
        try {
            if (this._host.inFullscreen?.())
                return true; // o próprio Shell sabe se algum monitor está em fullscreen
        } catch (e) {
            this._host.logError(e);
        }
        const active = this._activeWorkspaceIndex();
        for (const rec of this._records.values()) {
            try {
                if (!rec.win.minimized && rec.win.is_fullscreen() && this._workspaceOf(rec) === active)
                    return true;
            } catch (e) {
                this._host.logError(e);
            }
        }
        return false;
    }

    /** Janelas trazidas para cima de um fullscreen/maximizada no workspace activo. */
    broughtRecords() {
        const active = this._activeWorkspaceIndex();
        const out = [];
        for (const rec of this._records.values()) {
            try {
                if (rec.overlayShown && !rec.win.minimized && this._workspaceOf(rec) === active && this._overlaid(rec))
                    out.push(rec);
            } catch (e) {
                this._host.logError(e);
            }
        }
        return out;
    }

    /**
     * Manda as janelas trazidas de volta para o seu lugar de tiling (por trás do fullscreen):
     * a animação de aparecer ao contrário — vão do sítio onde estão até ao slot a desvanecer.
     */
    sendBrought() {
        const brought = this.broughtRecords();
        if (brought.length === 0)
            return;
        let ms = 0;
        let fullscreenWin = null;
        for (const other of this._records.values()) {
            if (!other.win.minimized && isOverlay(other.win) && this._workspaceOf(other) === this._activeWorkspaceIndex())
                fullscreenWin = other.win;
        }
        for (const rec of brought) {
            try {
                const win = rec.win;
                const slot = rec.lastTarget ? {...rec.lastTarget} : null;
                rec.overlayShown = false;
                rec.preHidden = false;
                if (!slot)
                    continue;
                const current = win.get_frame_rect();
                this._animator.cancel(win);
                win.move_resize_frame(false, slot.x, slot.y, slot.width, slot.height);
                ms = Math.max(ms, this._animator.disappear(rec, current, slot, 1.5));
            } catch (e) {
                this._host.logError(e);
            }
        }
        this._host.log(`janelas trazidas enviadas de volta ao slot (${brought.length})`);
        // O fullscreen volta à frente mesmo antes do fim, quando as janelas já estão transparentes.
        const raise = () => {
            try {
                this._syncAbove(); // já não são "trazidas": deixam de estar à frente
                if (this._enabled && fullscreenWin && !fullscreenWin.minimized)
                    this._host.activate(fullscreenWin);
            } catch (e) {
                this._host.logError(e);
            }
            this._notifyState();
        };
        if (ms > 0)
            this._host.addTimeout(Math.round(ms * 0.9), raise);
        else
            raise();
        this._notifyState();
    }

    /** Repõe a organização automática original do workspace activo. O tiling continua ligado. */
    restoreLayout() {
        const active = this._activeWorkspaceIndex();
        for (const rec of this._records.values()) {
            try {
                if (this._workspaceOf(rec) === active) {
                    rec.manual = null;
                    rec.manualSig = null;
                }
            } catch (e) {
                this._host.logError(e);
            }
        }
        this.layoutNow();
        this._notifyState();
    }

    /** @returns {Function} Função que remove o listener. */
    onStateChanged(callback) {
        this._listeners.add(callback);
        return () => this._listeners.delete(callback);
    }

    // ---- Acções do utilizador -------------------------------------------

    toggleFloat() {
        const win = this._host.display.focus_window;
        if (!win)
            return;
        const rec = this._records.get(win.get_id()) ?? this._register(win);
        if (!rec)
            return;

        const floating = this._floating.toggle(rec, this._settings.snapshot());
        if (this._settings.tilingEnabled) {
            if (floating)
                this._releaseOne(rec);
            else
                this._routeOverflow(rec);
        }
        this.layoutNow();
        this._scheduleLateLayouts();
    }

    /**
     * Auto-reparação (chamada de poucos em poucos segundos pela extensão): se alguma janela
     * em tiling não está onde o layout a pôs (a app mexeu-se sozinha, ex. Firefox no
     * arranque), ou de vez em quando mesmo sem desvio (janela fantasma que ocupa um
     * slot), volta a calcular o layout. Nunca mexe durante arrastos nem em fullscreen.
     */
    heal() {
        try {
            this._revealStuck();
            this._onDockChanged(); // rede de segurança: o dash pode mudar sem a Dash to Dock avisar
            if (!this._enabled || this._grab || this._inLayout || !this._settings.tilingEnabled)
                return;
            this._healTicks = (this._healTicks ?? 0) + 1;
            const config = this._settings.snapshot();
            let drift = false;
            for (const rec of this._records.values()) {
                if (!rec.lastTarget || rec.win.minimized || isHandsOff(rec.win) || !this._laidOut(rec, config))
                    continue;
                const actual = rec.win.get_frame_rect();
                const t = rec.lastTarget;
                const bigger = actual.width > t.width + RESIZE_TOLERANCE || actual.height > t.height + RESIZE_TOLERANCE;
                if (!bigger && !sameRect(actual, t, 3)) {
                    drift = true;
                    break;
                }
            }
            if (drift || this._healTicks <= 5 || this._healTicks % 10 === 0) { // nos primeiros ~10 s recalcula sempre; depois só de vez em quando
                if (drift)
                    this._host.log('auto-reparação: janela fora do sítio, a recalcular');
                this.layoutNow();
            }
        } catch (e) {
            this._host.logError(e);
        }
    }

    /** Janela focada e o seu grupo (só janelas realmente em tiling). */
    _focusedGroup() {
        const win = this._host.display.focus_window;
        const rec = win ? this._records.get(win.get_id()) : null;
        if (!rec || !this._settings.tilingEnabled)
            return {};
        const group = this._groupOf(rec, this._settings.snapshot());
        return group ? {rec, group} : {};
    }

    /** Troca a janela focada com a vizinha na direcção indicada (atalho de teclado). */
    swapDirection(dir) {
        try {
            const {rec, group} = this._focusedGroup();
            if (!rec || isHandsOff(rec.win))
                return;
            const mid = r => ({x: r.x + r.width / 2, y: r.y + r.height / 2});
            const from = rec.win.get_frame_rect();
            const c = mid(from);
            const horizontal = dir === 'left' || dir === 'right';
            const sign = dir === 'left' || dir === 'up' ? -1 : 1;
            let best = null;
            for (const other of group.records) {
                if (other === rec || isHandsOff(other.win))
                    continue;
                const f = other.win.get_frame_rect();
                const m = mid(f);
                const along = (horizontal ? m.x - c.x : m.y - c.y) * sign;
                if (along <= 0)
                    continue;
                const across = Math.abs(horizontal ? m.y - c.y : m.x - c.x);
                const overlaps = horizontal
                    ? f.y < from.y + from.height && from.y < f.y + f.height
                    : f.x < from.x + from.width && from.x < f.x + f.width;
                const score = (overlaps ? 0 : 1e6) + along + across * 2;
                if (!best || score < best.score)
                    best = {other, score};
            }
            if (!best)
                return;
            [rec.seq, best.other.seq] = [best.other.seq, rec.seq];
            [rec.manual, best.other.manual] = [best.other.manual, rec.manual];
            this._host.log(`troca por atalho (${dir}): ${rec.id} <-> ${best.other.id}`);
            this.layoutNow();
        } catch (e) {
            this._host.logError(e);
        }
    }

    /** Passa o foco para a janela seguinte do tiling (volta ao início no fim). */
    focusNext() {
        try {
            const {rec, group} = this._focusedGroup();
            const list = group ? group.records.filter(r => !r.win.minimized) : [];
            if (!rec || list.length < 2)
                return;
            const next = list[(list.indexOf(rec) + 1) % list.length];
            this._host.activate?.(next.win);
        } catch (e) {
            this._host.logError(e);
        }
    }

    /** Fixa/desafixa a janela focada em todos os workspaces (fica flutuante enquanto fixa). */
    togglePin() {
        try {
            const win = this._host.display.focus_window;
            const rec = win ? this._records.get(win.get_id()) : null;
            if (!rec)
                return;
            if (win.is_on_all_workspaces())
                win.unstick();
            else
                win.stick();
            rec.autoReason = undefined; // reavalia: fixa = flutuante
            this.layoutNow();
        } catch (e) {
            this._host.logError(e);
        }
    }

    toggleTiling() {
        this._settings.tilingEnabled = !this._settings.tilingEnabled;
    }

    _onSettingChanged(key) {
        this._host.log(`definição alterada: ${key}`);
        if (key === 'float-wm-classes' || key === 'tile-video-players') {
            for (const rec of this._records.values())
                rec.autoReason = undefined; // reavalia as regras automáticas com a nova definição
        }
        if (key === 'tiling-enabled') {
            this.layoutNow();
        } else {
            if (key.startsWith('dock-reserve')) {
                this._lastReserve = -1;
                this.layoutNow();
                // A dock anima ao mudar: mede outra vez já assentada.
                this._host.addTimeout(600, () => this._enabled && this._onDockChanged());
            } else {
                this.scheduleLayout();
            }
        }
        this._notifyState();
    }

    // ---- Registo de janelas ---------------------------------------------

    _onMap(actor) {
        const win = actor?.meta_window;
        if (!win)
            return;
        const rec = this._register(win);
        if (!rec) {
            this._host.log(`janela ${win.get_id()} (${win.get_wm_class()}): ignorada (tipo ${win.get_window_type()})`);
            return;
        }

        const isNew = !rec.opened;
        this._applyOpenPolicy(rec);
        if (isNew) {
            rec.justOpened = true; // o Shell já anima a abertura; só a substituímos pela nossa (animateOpen)
            this._routeOverflow(rec);
            // Esconde JÁ, antes de qualquer layout: a janela nunca se vê no tamanho flutuante.
            rec.openHidden = this._openFadeWanted(win);
            if (rec.openHidden) {
                this._host.cancelShellEffects?.(win);
                this._host.setOpacity(win, HIDDEN_OPACITY);
            }
        }
        this.layoutNow();
        if (isNew)
            this._animateOpen(rec);
    }

    /**
     * Abertura mais suave que a do Shell (150 ms): só desvanece (sem mexer nem crescer), já no lugar.
     * Primeiro tira as transições do próprio Shell, para não se cortarem umas às outras.
     */
    _openFadeWanted(win) {
        return Boolean(this._settings.hideUntilSized && !win.minimized && !isHandsOff(win));
    }

    /** Faixa inferior livre para a dock: a medida da Dash to Dock, ou o valor manual. */
    _dockReserve() {
        let reserve = 0;
        if (this._settings.dockReserveEnabled) {
            const measured = this._settings.dockReserveAuto ? (this._host.dockHeight?.() ?? 0) : 0;
            reserve = measured > 0 ? measured + this._settings.dockReserveMargin : this._settings.dockReserve;
            if (measured > 0 && measured !== this._lastDockHeight) {
                this._lastDockHeight = measured;
                this._host.log(`dock detectada: ${measured}px reservados`);
            }
        }
        if (this._settings.dockReserveEnabled && this._settings.dockReserveAuto && !(reserve > 0 && this._lastDockHeight > 0)) {
            const info = this._host.dockDiagnostic?.();
            if (info)
                this._logChanged('dock-diag', `dock: não medida (${info}); a usar o valor manual`);
        }
        this._lastReserve = reserve;
        return reserve;
    }

    /** A dock mudou de tamanho/posição: refaz o layout (sem esperar por uma janela mexer). */
    _onDockChanged() {
        if (!this._enabled || !this._settings.dockReserveEnabled)
            return;
        if (this._dockTimer)
            this._host.removeTimeout(this._dockTimer);
        // Pequena espera: a dock faz animações ao mudar e emite vários sinais seguidos.
        this._dockTimer = this._host.addTimeout(120, () => {
            this._dockTimer = 0;
            if (!this._enabled)
                return;
            const before = this._lastReserve;
            if (this._dockReserve() !== before)
                this.layoutNow();
        });
    }

    /** Nunca deixa uma janela invisível: opacidade 0 sem espera/animação nossa, passado o tempo de abertura. */
    _revealStuck() {
        if (!this._enabled)
            return;
        for (const rec of this._records.values()) {
            try {
                if (rec.openAwait || rec.win.minimized || !rec.mappedAt || this._now() - rec.mappedAt < OPEN_AWAIT_MS + 1500)
                    continue;
                if (this._host.revealStuck?.(rec.win))
                    this._host.log(`janela ${rec.id} (${rec.win.get_wm_class()}): estava invisível, reposta`);
            } catch (e) {
                this._host.logError(e);
            }
        }
    }

    /** Regista só quando o texto muda (os layouts repetem-se e enchiam o journal). */
    _logChanged(key, text) {
        this._lastLogs ??= new Map();
        if (this._lastLogs.get(key) === text)
            return;
        this._lastLogs.set(key, text);
        this._host.log(text);
    }

    _awaitOpenSlot(rec) {
        if (rec.openAwait)
            return;
        rec.openAwait = true;
        rec.openRelease = this._host.holdHidden?.(rec.win) ?? null;
        rec.openTimer = this._host.addTimeout(OPEN_AWAIT_MS, () => {
            rec.openTimer = 0;
            this._endOpenAwait(rec, true);
        });
    }

    _endOpenAwait(rec, timedOut) {
        if (!rec.openAwait)
            return;
        rec.openAwait = false;
        if (rec.openTimer) {
            this._host.removeTimeout(rec.openTimer);
            rec.openTimer = 0;
        }
        try {
            rec.openRelease?.();
        } catch (e) {
            this._host.logError(e);
        }
        rec.openRelease = null;
        if (timedOut)
            this._host.setOpacity(rec.win, 255); // nunca fica invisível
        else
            this._animateOpen(rec);
    }

    /** Depois de um layout: janelas que esperavam pelo seu lugar já o têm? */
    _openAwaiting() {
        for (const rec of this._records.values()) {
            if (rec.openAwait && rec.lastTarget)
                this._endOpenAwait(rec, false);
        }
    }

    _animateOpen(rec) {
        const hidden = rec.openHidden;
        rec.openHidden = false;
        try {
            const win = rec.win;
            if (!hidden && !this._openFadeWanted(win))
                return;
            if (!rec.lastTarget && hidden && this._inTiling(rec, this._settings.snapshot())) {
                // Apps que abrem maximizadas são registadas "ocultas" e só entram em tiling mais
                // tarde: sem lugar ainda, a janela fica escondida até o ter (máx. OPEN_AWAIT_MS).
                this._awaitOpenSlot(rec);
                return;
            }
            const to = rec.lastTarget ? {...rec.lastTarget} : win.get_frame_rect();
            if (!hidden) {
                this._host.cancelShellEffects?.(win);
                this._host.setOpacity(win, HIDDEN_OPACITY);
            }
            const fade = this._settings.animateOpen && this._settings.animationsEnabled && this._host.animationsAllowed();
            if (!this._animator.appear(rec, to, 1.2, null, true, true, !fade))
                this._host.setOpacity(win, 255);
            else
                this._host.log(`animação de abertura (${win.get_wm_class()})`);
        } catch (e) {
            this._host.logError(e);
            this._host.setOpacity(rec.win, 255); // nunca fica invisível
        }
    }

    /**
     * ÚNICA excepção à regra "a extensão nunca altera a maximização": uma janela
     * nova que abre maximizada (o app lembrou-se de que a fechaste maximizada) é
     * desmaximizada para entrar em tiling. Só acontece durante a fase de abertura
     * (OPEN_GRACE_MS desde o `map`), porque muitas apps (Firefox, Telegram, Discord)
     * só repõem o estado maximizado alguns instantes DEPOIS de a janela aparecer.
     * Fora dessa fase, maximizar é decisão do utilizador e é sempre respeitada.
     * Fullscreen nunca é alterado (jogos, vídeo).
     */
    _applyOpenPolicy(rec) {
        if (rec.opened)
            return;
        rec.opened = true;
        rec.mappedAt = this._now();
        this._unmaximizeIfOpening(rec);
    }

    _now() {
        return this._host.now?.() ?? Date.now();
    }

    /** Chamado quando uma janela fica maximizada: decide se é "estado lembrado" da abertura. */
    _onMaximizedWhileOpening(rec) {
        if (rec.lateUnmaxPending || !this._isOpeningMaximized(rec))
            return;
        rec.lateUnmaxPending = true;
        // Fora do handler do sinal: nunca se chama unmaximize() dentro de um tratamento de maximização.
        this._host.addTimeout(LATE_UNMAX_DELAY_MS, () => {
            rec.lateUnmaxPending = false;
            if (this._records.get(rec.id) === rec)
                this._unmaximizeIfOpening(rec);
        });
    }

    _isOpeningMaximized(rec) {
        const win = rec.win;
        return this._enabled && this._settings.tilingEnabled && this._settings.unmaximizeOnOpen &&
            rec.mappedAt && this._now() - rec.mappedAt <= OPEN_GRACE_MS &&
            (rec.openUnmaxCount ?? 0) < MAX_OPEN_UNMAX &&
            !win.is_fullscreen() && !win.minimized &&
            (win.maximized_horizontally || win.maximized_vertically);
    }

    _unmaximizeIfOpening(rec) {
        if (!this._isOpeningMaximized(rec))
            return;
        rec.openUnmaxCount = (rec.openUnmaxCount ?? 0) + 1;
        try {
            rec.win.unmaximize();
            this._host.log(`janela ${rec.id} (${rec.win.get_wm_class()}): abriu maximizada, desmaximizada`);
        } catch (e) {
            this._host.logError(e);
        }
    }

    _register(win, {existing = false} = {}) {
        if (!this._enabled || !isManageable(win, this._host.windowTypeNormal))
            return this._records.get(win?.get_id?.()) ?? null;

        const id = win.get_id();
        const known = this._records.get(id);
        if (known)
            return known;

        const rec = {
            id,
            win,
            seq: ++this._seq,
            override: null,        // 'float' | 'tile' | null (escolha do utilizador)
            autoReason: undefined, // motivo de flutuação automática (avaliado uma vez)
            manual: null,          // célula ajustada à mão (fracções da área); null = layout automático
            manualSig: null,       // conjunto de janelas para que o ajuste vale
            original: null,        // geometria anterior ao tiling (guardada uma só vez)
            lastTarget: null,      // última geometria pedida pelo tiling
            minSize: null,         // tamanho mínimo revelado pela janela
            seen: null,
            decision: null,        // última decisão registada no log
            opened: existing,      // política de abertura já aplicada (ou dispensada)
            routed: existing,      // limite por workspace já aplicado (ou dispensado)
            justOpened: false,
            noAnim: false,
        };
        this._records.set(id, rec);

        for (const name of WINDOW_SIGNALS) {
            this._signals.connect(win, name, () => {
                rec.noAnim = name.startsWith('notify::maximized'); // o Shell anima maximizar; o regresso do fullscreen anima-se aqui
                if (name.startsWith('notify::maximized'))
                    this._onMaximizedWhileOpening(rec);
                // Experimental: ao SAIR de maximizada/fullscreen, relayout antes do próximo frame
                // (o Mutter mostra logo o tamanho flutuante antigo). Nunca dentro do sinal: reentrar
                // no Mutter aí fez o Shell crashar — por isso vai por "beforeRedraw".
                if (this._settings.fastUnmaximize && !this._redrawQueued && !isHandsOff(win)) {
                    this._redrawQueued = true;
                    (this._host.beforeRedraw ?? ((fn) => this._host.addTimeout(0, fn)))(() => {
                        this._redrawQueued = false;
                        if (this._enabled && !isHandsOff(win))
                            this.layoutNow();
                    });
                }
                this.scheduleLayout();
            }, id);
        }
        // Convergência: a app GNOME/GTK4 aplica o tamanho por defeito do Mutter (~90 %) DEPOIS do
        // nosso pedido. Em vez de esperar pelo relógio, cada size-changed de uma janela nova
        // compara com o alvo e repõe-no (adiado: nunca dentro do sinal do Mutter).
        this._signals.connect(win, 'size-changed', () => this._scheduleConverge(rec), id);
        this._signals.connect(win, 'notify::minimized', () => this._onMinimizedChanged(rec), id);
        this._signals.connect(win, 'unmanaging', () => this._unregister(id), id);
        return rec;
    }

    _scheduleConverge(rec) {
        if (rec.convSource || !this._enabled || this._grab || !rec.mappedAt ||
            this._now() - rec.mappedAt > CONVERGE_MS || (rec.convTries ?? 0) >= CONVERGE_TRIES)
            return;
        rec.convSource = this._host.addTimeout(CONVERGE_DELAY_MS, () => {
            rec.convSource = 0;
            try {
                if (!this._enabled || this._grab || this._inLayout || !this._records.has(rec.id) ||
                    !this._settings.tilingEnabled || !rec.lastTarget || rec.win.minimized ||
                    isHandsOff(rec.win) || !this._laidOut(rec, this._settings.snapshot()))
                    return;
                const a = rec.win.get_frame_rect();
                const t = rec.lastTarget;
                const off = a.width < t.width - RESIZE_TOLERANCE || a.height < t.height - RESIZE_TOLERANCE ||
                    Math.abs(a.x - t.x) > RESIZE_TOLERANCE || Math.abs(a.y - t.y) > RESIZE_TOLERANCE;
                if (!off)
                    return;
                rec.convTries = (rec.convTries ?? 0) + 1;
                this._host.log(`convergência: ${rec.win.get_wm_class()} em ${a.width}x${a.height}+${a.x}+${a.y}, ` +
                    `repõe ${t.width}x${t.height}+${t.x}+${t.y} (${rec.convTries})`);
                // Do 4.º pedido em diante, como pedido do utilizador: as apps que ignoram o normal cedem.
                rec.win.move_resize_frame(rec.convTries > 3, t.x, t.y, t.width, t.height);
            } catch (e) {
                this._host.logError(e);
            }
        });
    }

    _unregister(id) {
        const rec = this._records.get(id);
        if (!rec)
            return;
        if (rec.convSource) {
            this._host.removeTimeout(rec.convSource);
            rec.convSource = 0;
        }
        this._animator.cancel(rec.win); // fechar durante uma animação: nada fica a meio
        this._setAbove(rec, false);
        this._records.delete(id);
        this._signals.disconnectGroup(id);
        if (this._grab?.id === id) {
            this._signals.disconnectGroup('grab');
            this._grab = null;
        }
        if (this._pendingLearn?.id === id)
            this._pendingLearn = null;
        this.scheduleLayout();
    }

    _onMinimizedChanged(rec) {
        rec.noAnim = false;
        if (!rec.win.minimized && this._settings.tilingEnabled)
            this._routeOverflow(rec); // restaurar não pode furar o limite
        this.scheduleLayout();
    }

    // ---- Limite de janelas por workspace --------------------------------

    /**
     * Se o workspace da janela já tem o máximo de janelas em tiling (sem contar
     * minimizadas, excluídas do tiling nem outros workspaces), envia-a para o
     * primeiro workspace seguinte com espaço, reutilizando os existentes.
     */
    _routeOverflow(rec) {
        try {
            const win = rec.win;
            const config = this._settings.snapshot();
            if (!this._settings.tilingEnabled || win.minimized || this._floating.isFloating(rec, config) !== false)
                return;
            const workspace = win.get_workspace();
            if (!workspace)
                return;

            const count = this._host.workspaceManager.n_workspaces;
            const counts = [];
            for (let i = 0; i < count; i++)
                counts.push(this._tileCount(i, rec.id, config));

            const start = workspace.index();
            const target = pickWorkspace(counts, start, this._settings.maxWindows);
            if (target === start)
                return;

            this._host.moveWindowToWorkspace(win, target);
            this._host.log(`janela ${rec.id} (${win.get_wm_class()}): workspace ${start + 1} cheio, enviada para ${target + 1}`);
        } catch (e) {
            this._host.logError(e);
        }
    }

    /**
     * Garante o limite em CADA layout, não só quando uma janela abre: cobre janelas
     * que abriram maximizadas, que já existiam ao arrancar, que foram restauradas ou
     * movidas à mão. O excesso (as janelas mais recentes) vai para o workspace
     * seguinte com espaço. Maximizadas/fullscreen contam, mas nunca são movidas.
     * @returns {object[]} Os participantes que ficam neste layout.
     */
    _enforceLimit(participants) {
        const max = this._settings.maxWindows;
        const byWorkspace = [];
        for (const rec of participants) {
            const index = this._workspaceOf(rec);
            if (index < 0)
                continue;
            (byWorkspace[index] ??= []).push(rec);
        }
        const counts = [];
        const total = this._host.workspaceManager.n_workspaces;
        for (let i = 0; i < Math.max(total, byWorkspace.length); i++)
            counts.push(byWorkspace[i]?.length ?? 0);

        const moved = new Set();
        for (let index = 0; index < counts.length; index++) {
            while (counts[index] > max) {
                const candidate = (byWorkspace[index] ?? [])
                    .filter(rec => !moved.has(rec) && !isHandsOff(rec.win))
                    .sort((a, b) => b.seq - a.seq)[0];
                if (!candidate)
                    break;
                const target = pickWorkspace(counts, index + 1, max);
                try {
                    this._host.moveWindowToWorkspace(candidate.win, target);
                } catch (e) {
                    this._host.logError(e);
                    break;
                }
                this._host.log(`janela ${candidate.id} (${candidate.win.get_wm_class()}): ` +
                    `workspace ${index + 1} acima do limite (${max}), enviada para ${target + 1}`);
                moved.add(candidate);
                counts[index]--;
                counts[target] = (counts[target] ?? 0) + 1;
                (byWorkspace[target] ??= []).push(candidate);
            }
        }
        return participants.filter(rec => !moved.has(rec));
    }

    _tileCount(workspaceIndex, exceptId, config) {
        let n = 0;
        for (const rec of this._records.values()) {
            if (rec.id === exceptId)
                continue;
            try {
                if (this._workspaceOf(rec) === workspaceIndex && this._inTiling(rec, config))
                    n++;
            } catch (e) {
                this._host.logError(e);
            }
        }
        return n;
    }

    _workspaceOf(rec) {
        return rec.win.get_workspace()?.index() ?? -1;
    }

    _activeWorkspaceIndex() {
        return this._host.workspaceManager.get_active_workspace().index();
    }

    // ---- Arrasto / redimensionamento manual -----------------------------

    _onGrabBegin(win) {
        const rec = win ? this._records.get(win.get_id()) : null;
        if (!rec)
            return;
        // Com o tiling desligado (ou numa janela temporariamente flutuante) o
        // utilizador manda: a extensão não acompanha nem reorganiza nada.
        if (!this._settings.tilingEnabled || !this._laidOut(rec, this._settings.snapshot()))
            return;
        this._animator.cancel(win);
        const frame = win.get_frame_rect();
        this._grab = {id: rec.id, width: frame.width, height: frame.height, x: frame.x, y: frame.y};
        // Só durante o arrasto do utilizador: as vizinhas acompanham ao vivo.
        this._signals.connect(win, 'size-changed', () => this._onGrabbedResized(), 'grab');
        // Marca onde a janela vai ficar se for largada agora (troca ao arrastar).
        this._signals.connect(win, 'position-changed', () => this._scheduleHint(), 'grab');
    }

    _scheduleHint() {
        if (this._hintSource || !this._grab || !this._settings.swapOnDrag)
            return;
        this._hintSource = this._host.addTimeout(LIVE_MS, () => {
            this._hintSource = 0;
            this._updateHint();
        });
    }

    _updateHint() {
        if (!this._grab || !this._host.showDropHint)
            return;
        try {
            const rec = this._records.get(this._grab.id);
            const other = rec ? this._swapTarget(this._grab, rec) : null;
            if (other) {
                this._host.showDropHint({...other.lastTarget});
                this._hintShown = true;
            } else {
                this._hideHint();
            }
        } catch (e) {
            this._host.logError(e);
        }
    }

    _hideHint() {
        if (this._hintShown || this._hintSource) {
            try {
                this._host.hideDropHint?.();
            } catch (e) {
                this._host.logError(e);
            }
        }
        this._hintShown = false;
        if (this._hintSource) {
            this._host.removeTimeout(this._hintSource);
            this._hintSource = 0;
        }
    }

    _onGrabbedResized() {
        if (!this._grab || this._liveSource)
            return;
        this._liveSource = this._host.addTimeout(LIVE_MS, () => {
            this._liveSource = 0;
            this._liveLayout();
        });
    }

    /** Uma passagem ao vivo: aprende a nova proporção e ajusta as vizinhas, sem animar. */
    _liveLayout() {
        const grab = this._grab;
        const rec = grab ? this._records.get(grab.id) : null;
        if (!rec || this._inLayout)
            return;

        this._inLayout = true;
        try {
            const frame = rec.win.get_frame_rect();
            if (Math.abs(frame.width - grab.width) <= RESIZE_TOLERANCE &&
                Math.abs(frame.height - grab.height) <= RESIZE_TOLERANCE)
                return; // é só um movimento, não um redimensionamento

            const config = this._settings.snapshot();
            const group = this._groupOf(rec, config);
            const area = group ? this._monitors.workAreaOf(rec.win) : null;
            if (!group || !area)
                return;

            this._engine.learnFromResize(group.records, area, config, rec);
            this._engine.normalize(group.records, area, config);
            this._engine.layoutGroup(group.records, area, config, {skipId: rec.id});
            this._notifyState();
        } catch (e) {
            this._host.logError(e);
        } finally {
            this._inLayout = false;
        }
    }

    _onGrabEnd() {
        const grab = this._grab;
        this._endGrab();
        if (grab && !this._trySwap(grab))
            this._pendingLearn = grab;
        this.scheduleLayout();
    }

    _endGrab() {
        this._hideHint();
        this._grab = null;
        this._signals.disconnectGroup('grab');
        if (this._liveSource) {
            this._host.removeTimeout(this._liveSource);
            this._liveSource = 0;
        }
    }

    /**
     * Arrastar uma janela em tiling para cima de outra troca as duas de lugar
     * (e as proporções ficam com o lugar, não com a janela). Largar fora de
     * qualquer janela faz a janela voltar ao seu sítio.
     * @returns {boolean} Se houve troca.
     */
    /** A janela arrastada está por cima de qual outra (do mesmo grupo)? null se nenhuma. */
    _swapTarget(grab, rec) {
        if (!this._settings.swapOnDrag || !rec.lastTarget || rec.win.minimized || isHandsOff(rec.win))
            return null;

        const frame = rec.win.get_frame_rect();
        if (Math.abs(frame.width - grab.width) > RESIZE_TOLERANCE ||
            Math.abs(frame.height - grab.height) > RESIZE_TOLERANCE)
            return null; // é um redimensionamento
        if (Math.abs(frame.x - grab.x) < MOVE_THRESHOLD && Math.abs(frame.y - grab.y) < MOVE_THRESHOLD)
            return null; // clique ou movimento mínimo

        const group = this._groupOf(rec, this._settings.snapshot());
        if (!group)
            return null;

        const point = this._host.pointer?.() ??
            {x: frame.x + frame.width / 2, y: frame.y + frame.height / 2};
        const inside = (r, p) => p.x >= r.x && p.x < r.x + r.width && p.y >= r.y && p.y < r.y + r.height;
        return group.records.find(r => r !== rec && r.lastTarget && !isHandsOff(r.win) &&
            inside(r.lastTarget, point)) ?? null;
    }

    _trySwap(grab) {
        try {
            const rec = this._records.get(grab.id);
            const other = rec ? this._swapTarget(grab, rec) : null;
            if (!rec || !other)
                return false;
            [rec.seq, other.seq] = [other.seq, rec.seq];
            [rec.manual, other.manual] = [other.manual, rec.manual];
            this._host.log(`troca: janela ${rec.id} (${rec.win.get_wm_class()}) <-> ` +
                `${other.id} (${other.win.get_wm_class()})`);
            return true;
        } catch (e) {
            this._host.logError(e);
            return false;
        }
    }

    // ---- Layout ---------------------------------------------------------

    scheduleLayout() {
        if (!this._enabled || this._source)
            return;
        this._source = this._host.addTimeout(DEBOUNCE_MS, () => {
            this._source = 0;
            this.layoutNow();
        });
    }

    layoutNow() {
        // Rede de segurança: um "grab" que ficou preso (sem grab-op-end) pararia o tiling para sempre.
        if (this._grab && this._host.grabActive && !this._host.grabActive())
            this._endGrab();
        if (!this._enabled || this._grab)
            return;
        if (this._inLayout) {
            this.scheduleLayout();
            return;
        }

        this._inLayout = true;
        try {
            this._sweepStale();
            const config = this._settings.snapshot();
            if (this._settings.tilingEnabled) {
                const moves = this._layoutAll(config);
                this._playAnimations(moves);
                if (moves.length > 0) {
                    this._scheduleVerify();
                    this._retryUndersized(1);
                }
            } else {
                // Animada (com fade nas mudanças grandes de tamanho, para disfarçar o corte).
                const moves = this._releasePending();
                this._playAnimations(moves);
                if (moves.length > 0)
                    this._scheduleReleaseVerify();
            }
        } catch (e) {
            this._host.logError(e);
        } finally {
            this._inLayout = false;
            this._syncAbove();
            this._openAwaiting();
            this._notifyState();
        }
    }

    // ---- Janelas flutuantes sempre à frente -----------------------------

    /** Põe/retira a janela da camada "sempre à frente" — só se foi a extensão a pô-la. */
    _setAbove(rec, above) {
        try {
            if (above && !rec.aboveByUs) {
                if (rec.win.is_above?.())
                    return; // já estava assim por escolha do utilizador/app: não é nossa
                rec.win.make_above();
                rec.aboveByUs = true;
            } else if (!above && rec.aboveByUs) {
                rec.aboveByUs = false;
                rec.win.unmake_above();
            }
        } catch (e) {
            this._host.logError(e); // janela a ser destruída
        }
    }

    _syncAbove() {
        try {
            const config = this._settings.snapshot();
            const active = this._enabled && this._settings.tilingEnabled && this._settings.floatingOnTop &&
                !this.hasFullscreen();
            for (const rec of this._records.values()) {
                // As trazidas por cima de um fullscreen ficam à frente MESMO que o fullscreen volte a
                // ganhar o foco (senão desapareciam atrás dele e reapareciam só no regresso).
                const wants = rec.holdAbove ||
                    (!rec.win.minimized && rec.overlayShown && this._enabled && this._settings.tilingEnabled) ||
                    (active && !rec.win.minimized && this._decide(rec, config).startsWith('flutuante'));
                this._setAbove(rec, wants);
            }
        } catch (e) {
            this._host.logError(e);
        }
    }

    _dropAllAbove() {
        for (const rec of this._records.values())
            this._setAbove(rec, false);
    }

    _layoutAll(config) {
        // `counted`: janelas em tiling (contam para o limite); `participants`: as que
        // são realmente colocadas (as sobrepostas por uma maximizada/fullscreen não).
        const counted = [];
        for (const rec of this._records.values()) {
            try {
                if (this._participates(rec, config))
                    counted.push(rec);
            } catch (e) {
                // Janela a meio de ser destruída: ignora-a nesta passagem.
                this._host.logError(e);
            }
        }

        const kept = this._enforceLimit(counted);
        const participants = kept.filter(rec => !this._overlaid(rec));
        for (const rec of participants) {
            if (rec.overlayShown)
                rec.returning = true; // estava trazida por cima de um fullscreen: o regresso anima-se
            rec.overlayShown = false; // voltou ao layout: um novo episódio poderá redimensioná-la
        }
        const groups = buildGroups(participants, this._settings.openSide === 'left');
        this._learnPending(groups, config);
        this._logChanged('resumo', `layout: ${this._records.size} janelas registadas, ${kept.length} em tiling ` +
            `(${participants.length} colocadas), ${groups.size} grupo(s), limite ${this._settings.maxWindows}`);
        if (participants.length >= 2 && participants.length <= 4) {
            // Diagnóstico do arranque: quem está a ocupar slots (uma janela fantasma deixa metade do ecrã vazia).
            const describe = rec => {
                const f = rec.win.get_frame_rect();
                return `${rec.id}:${rec.win.get_wm_class()}:"${String(rec.win.get_title?.() ?? '').slice(0, 24)}":` +
                    `${f.width}x${f.height}${this._isDisplayed(rec.win) ? '' : ':oculta'}`;
            };
            try {
                this._logChanged('participantes', `layout: participantes ${participants.map(describe).join(' | ')}`);
            } catch {
                // janela a ser destruída: o diagnóstico não é importante
            }
        }

        // Um grupo com problemas não impede os restantes de serem organizados.
        const moves = [];
        for (const group of groups.values()) {
            try {
                const area = this._monitors.workAreaOf(group.records[0].win);
                if (area)
                    moves.push(...this._engine.layoutGroup(group.records, area, config));
            } catch (e) {
                this._host.logError(e);
            }
        }
        return moves;
    }

    /** Com o tiling desligado, devolve cada janela à geometria anterior (ou ao recurso 16:9). */
    _releasePending() {
        const moves = [];
        // Janelas sem geometria original credível espalham-se pelo ecrã (índice/total).
        const cascade = {n: 0, total: 0, sizePercent: this._settings.normalWindowSize};
        for (const rec of this._records.values()) {
            if (!rec.original && !rec.lastTarget)
                continue;
            const area = this._monitors.workAreaOf(rec.win);
            if (area && needsCascade(rec.original, area))
                cascade.total++;
        }
        for (const rec of this._records.values()) {
            if (!rec.original && !rec.lastTarget)
                continue;
            try {
                const move = this._releaseRecord(rec, cascade);
                if (move)
                    moves.push(move);
            } catch (e) {
                this._host.logError(e);
            }
        }
        return moves;
    }

    _releaseOne(rec) {
        try {
            this._playAnimations([this._releaseRecord(rec)].filter(Boolean));
        } catch (e) {
            this._host.logError(e);
        }
    }

    _releaseRecord(rec, cascade) {
        const area = this._monitors.workAreaOf(rec.win);
        return area ? this._engine.release(rec, area, cascade) : null;
    }

    _playAnimations(moves) {
        const returning = moves.filter(m => m.rec.returning);
        const animated = moves.filter(m => !m.rec.returning && !m.rec.noAnim && !m.rec.justOpened);
        for (const {rec} of moves) {
            rec.noAnim = false;
            rec.justOpened = false;
            rec.returning = false;
        }
        this._animator.play(animated);
        if (returning.length > 0) {
            this._host.log(`animação de regresso ao slot (${returning.length} janela(s) trazidas)`);
            this._animator.play(returning, {durationScale: 1.5, soft: true, noFade: true, wait: true}); // sem mexer na opacidade
            // Enquanto regressam ao slot continuam à frente da janela que saiu do fullscreen/
            // maximizada (que ganha o foco/ficaria por cima delas).
            for (const {rec} of returning) {
                rec.holdAbove = true;
                this._setAbove(rec, true);
            }
            this._host.addTimeout(HOLD_ABOVE_MS, () => {
                for (const {rec} of returning)
                    rec.holdAbove = false;
                if (this._enabled)
                    this._syncAbove();
            });
        }
    }

    // ---- Decisões sobre cada janela -------------------------------------

    /** A janela tem lugar no layout (maximizadas/fullscreen incluídas: o lugar fica reservado). */
    _participates(rec, config) {
        const decision = this._decide(rec, config);
        const label = decision.startsWith('tiling') && this._overlaid(rec)
            ? 'tiling (flutuante temporária: há uma janela maximizada/fullscreen)'
            : decision;
        if (label !== rec.decision) {
            rec.decision = label;
            this._host.log(`janela ${rec.id} (${rec.win.get_wm_class()}): ${label}`);
        }
        return decision.startsWith('tiling');
    }

    _inTiling(rec, config) {
        return this._decide(rec, config).startsWith('tiling');
    }

    /**
     * Há uma janela maximizada/fullscreen no mesmo workspace e monitor? Então esta
     * fica temporariamente flutuante: não é movida nem "presa" ao seu slot.
     */
    _overlaid(rec) {
        const win = rec.win;
        if (isOverlay(win) || win.minimized)
            return false;
        const workspace = this._workspaceOf(rec);
        const monitor = this._monitors.monitorOf(win);
        for (const other of this._records.values()) {
            if (other === rec || other.win.minimized || !isOverlay(other.win))
                continue;
            if (this._workspaceOf(other) === workspace && this._monitors.monitorOf(other.win) === monitor)
                return true;
        }
        return false;
    }

    /** Em tiling E realmente colocada pelo layout (não sobreposta). */
    _laidOut(rec, config) {
        return this._inTiling(rec, config) && !this._overlaid(rec);
    }

    _decide(rec, config) {
        const win = rec.win;
        if (win.minimized)
            return 'minimizada';
        // Janela que existe mas não se vê (escondida pela app, minúscula): não ocupa um slot.
        // Reavaliado a cada layout, nunca é uma decisão permanente.
        // Janela que acabou de aparecer: o Shell ainda pode não a dar como "visível"
        // no `map`; sem isto ela só seria colocada mais tarde (abria no centro e saltava).
        const fresh = rec.mappedAt && this._now() - rec.mappedAt < FRESH_MS;
        if (!this._isDisplayed(win, fresh))
            return 'oculta';
        const floating = this._floating.isFloating(rec, config);
        if (floating === null)
            return 'indeterminada';
        if (floating)
            return `flutuante (${rec.override === 'float' ? 'escolha do utilizador' : rec.autoReason})`;
        if (isHandsOff(win))
            return 'tiling (maximizada ou fullscreen: lugar reservado, janela não tocada)';
        return 'tiling';
    }

    _isDisplayed(win, fresh = false) {
        try {
            if (!fresh && typeof win.showing_on_its_workspace === 'function' && !win.showing_on_its_workspace())
                return false;
            const frame = win.get_frame_rect();
            return frame.width >= MIN_VISIBLE_PX && frame.height >= MIN_VISIBLE_PX;
        } catch {
            return true;
        }
    }

    /** Remove registos de janelas que já não existem mas de que não chegámos a receber o 'unmanaging'. */
    _sweepStale() {
        for (const [id, rec] of [...this._records]) {
            try {
                if (typeof rec.win.get_compositor_private === 'function' && !rec.win.get_compositor_private()) {
                    this._host.log(`janela ${id}: já não existe, registo removido`);
                    this._unregister(id);
                }
            } catch (e) {
                this._host.logError(e);
            }
        }
    }

    /** Reavaliações tardias depois de abrir uma janela: curam estados transitórios (arranque, janelas fantasma). */
    _scheduleLateLayouts() {
        if (this._lateSource)
            return;
        // Apps lentas (Firefox no arranque) repõem o seu próprio tamanho/posição segundos
        // depois de abrir: várias reavaliações espaçadas voltam a pô-las no sítio.
        const delays = LATE_LAYOUT_MS;
        const step = i => {
            this._lateSource = this._host.addTimeout(delays[i], () => {
                this._lateSource = 0;
                if (!this._enabled)
                    return;
                if (i + 1 < delays.length)
                    step(i + 1);
                this.layoutNow();
            });
        };
        step(0);
    }

    _groupOf(rec, config) {
        const participants = [];
        for (const r of this._records.values()) {
            try {
                if (this._laidOut(r, config))
                    participants.push(r);
            } catch (e) {
                this._host.logError(e);
            }
        }
        for (const group of buildGroups(participants, this._settings.openSide === 'left').values()) {
            if (group.records.includes(rec))
                return group;
        }
        return null;
    }

    /** Converte o último redimensionamento manual em proporções preservadas. */
    _learnPending(groups, config) {
        const pending = this._pendingLearn;
        this._pendingLearn = null;
        const rec = pending ? this._records.get(pending.id) : null;
        if (!rec)
            return;

        const frame = rec.win.get_frame_rect();
        const resized = Math.abs(frame.width - pending.width) > RESIZE_TOLERANCE ||
            Math.abs(frame.height - pending.height) > RESIZE_TOLERANCE;
        if (!resized)
            return;

        for (const group of groups.values()) {
            if (!group.records.includes(rec))
                continue;
            const area = this._monitors.workAreaOf(rec.win);
            if (area) {
                this._engine.learnFromResize(group.records, area, config, rec);
                this._engine.normalize(group.records, area, config);
            }
            return;
        }
    }

    // ---- Tamanhos mínimos revelados pelas janelas -----------------------

    /**
     * Se uma janela fica maior do que o pedido de forma estável (duas leituras
     * iguais), esse é o seu mínimo: passa a ser respeitado pelo layout.
     * Duas leituras evitam confundir "ainda não redimensionou" com "não consegue".
     */
    /**
     * Depois de libertar as janelas, confirma que chegaram ao destino; se algum
     * cliente ignorou o primeiro pedido, repete-o (duas vezes, no máximo).
     */
    // ---- Janela trazida para a frente durante fullscreen/maximizada ------

    /**
     * Janela de tiling trazida por cima de um fullscreen: o Shell mostra-a logo no sítio
     * antigo, a 100 %, antes de a animação de aparecer arrancar (era o "corte" do início).
     * Fica transparente já, de forma síncrona; a animação (ou o fim do tratamento) repõe-na.
     */
    _preHide() {
        try {
            if (!this._enabled || this._grab || !this._settings.tilingEnabled || !this._settings.focusResizeEnabled ||
                !this._settings.animationsEnabled)
                return;
            const win = this._host.display.focus_window;
            const rec = win ? this._records.get(win.get_id()) : null;
            if (!rec || rec.overlayShown || rec.preHidden || win.minimized || isHandsOff(win))
                return;
            if (!this._inTiling(rec, this._settings.snapshot()) || !this._overlaid(rec))
                return;
            rec.preHidden = true;
            this._host.setOpacity?.(win, 0);
        } catch (e) {
            this._host.logError(e);
        }
    }

    _unHide() {
        for (const rec of this._records.values()) {
            if (!rec.preHidden)
                continue;
            rec.preHidden = false;
            if (!rec.appearing)
                this._host.setOpacity?.(rec.win, 255); // não houve animação: nunca fica invisível
            rec.appearing = false;
        }
    }

    _scheduleFocus() {
        this._preHide();
        if (this._focusSource || !this._enabled) {
            if (!this._focusSource)
                this._unHide();
            return;
        }
        this._focusSource = this._host.addTimeout(1, () => {
            this._focusSource = 0;
            try {
                this._onFocusChanged();
            } finally {
                this._unHide();
            }
        });
    }

    /**
     * Com outra janela em fullscreen/maximizada, trazer uma janela que estava em
     * tiling (por exemplo, pela barra de tarefas) mostra-a flutuante num tamanho
     * normal 16:9 em vez de ficar presa no seu slot. Só dentro do intervalo de
     * número de janelas escolhido nas preferências. Acontece uma vez por episódio.
     */
    _onFocusChanged() {
        if (!this._enabled || this._grab || !this._settings.tilingEnabled || !this._settings.focusResizeEnabled)
            return;
        try {
            const win = this._host.display.focus_window;
            const rec = win ? this._records.get(win.get_id()) : null;
            if (!rec || rec.overlayShown || win.minimized || isHandsOff(win))
                return;
            const config = this._settings.snapshot();
            if (!this._inTiling(rec, config) || !this._overlaid(rec))
                return;

            const workspace = this._workspaceOf(rec);
            const monitor = this._monitors.monitorOf(win);
            let count = 0;
            for (const other of this._records.values()) {
                if (this._workspaceOf(other) === workspace && this._monitors.monitorOf(other.win) === monitor &&
                    this._participates(other, config))
                    count++;
            }
            const {focusResizeMin: min, focusResizeMax: max} = this._settings;
            if (count < min || count > max) {
                this._host.log(`janela ${rec.id}: trazida com overlay mas ${count} janela(s) fora do intervalo ${min}-${max}`);
                return;
            }
            const area = this._monitors.workAreaOf(win);
            if (!area)
                return;
            // Posição normal da janela (a que tinha antes do tiling); sem ela, 16:9 centrada.
            const wanted = restoreFrame(rec.original, area, undefined, this._settings.normalWindowSize); // original credível ou centrada, nunca fora do ecrã
            const frame = this._avoidBrought(rec, wanted, area, workspace, monitor);
            // Parte do slot de tiling (último sítio planeado); a geometria actual pode já ser outra.
            const current = rec.lastTarget ? {...rec.lastTarget} : win.get_frame_rect();
            this._animator.cancel(win);
            rec.overlayShown = true;
            this._setAbove(rec, true);
            this._notifyState();
            win.move_resize_frame(false, frame.x, frame.y, frame.width, frame.height);
            this._host.log(`janela ${rec.id}: animação de aparecer (minimizada=${win.minimized}, ${this._now()} ms)`);
            rec.appearing = this._animator.appear(rec, frame, 1.5, current); // desvanecida e a crescer até ao sítio, com a borda
            this._host.log(`janela ${rec.id} (${win.get_wm_class()}): trazida durante fullscreen/maximizada -> ` +
                `${frame.width}x${frame.height}+${frame.x}+${frame.y} (${count} janelas; original ` +
                `${rec.original ? `${rec.original.width}x${rec.original.height}+${rec.original.x}+${rec.original.y}` : 'desconhecida'})`);
            this._verifyBrought(rec, frame, 1);
        } catch (e) {
            this._host.logError(e);
        }
    }

    /**
     * Uma segunda (terceira…) janela trazida durante o mesmo fullscreen não pode ficar
     * em cima das que já foram trazidas: procura uma posição livre e, na falta dela,
     * desloca-a em cascata.
     */
    _avoidBrought(rec, wanted, area, workspace, monitor) {
        const shown = [];
        for (const other of this._records.values()) {
            if (other !== rec && other.overlayShown && !other.win.minimized &&
                this._workspaceOf(other) === workspace && this._monitors.monitorOf(other.win) === monitor)
                shown.push(other.win.get_frame_rect());
        }
        const covered = (a, b) => {
            const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
            const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
            return w > 0 && h > 0 ? (w * h) / (a.width * a.height) : 0;
        };
        const free = candidate => !shown.some(f => covered(candidate, f) > 0.35);
        if (free(wanted))
            return wanted;
        for (let i = 0; i < 6; i++) {
            const slot = spreadSlot(i, 6, area, this._settings.normalWindowSize);
            if (free(slot))
                return slot;
        }
        return centredFrame(wanted, area, shown.length);
    }

    /** Confirma que a janela trazida ficou onde se pediu (e dentro do ecrã); repete até 2 vezes. */
    _verifyBrought(rec, frame, attempt) {
        this._host.addTimeout(VERIFY_MS, () => {
            try {
                if (!this._enabled || !this._records.has(rec.win.get_id()) || this._grab || rec.win.minimized)
                    return;
                const actual = rec.win.get_frame_rect();
                const area = this._monitors.workAreaOf(rec.win);
                const outside = area && (actual.x < area.x - 2 || actual.y < area.y - 2 ||
                    actual.x + actual.width > area.x + area.width + 2 ||
                    actual.y + actual.height > area.y + area.height + 2);
                if (!outside && sameRect(actual, frame, RESIZE_TOLERANCE))
                    return;
                this._host.log(`janela ${rec.id}: trazida (tentativa ${attempt}) pedido ` +
                    `${frame.width}x${frame.height}+${frame.x}+${frame.y}, obtido ` +
                    `${actual.width}x${actual.height}+${actual.x}+${actual.y}`);
                if (attempt < 3) {
                    rec.win.move_resize_frame(false, frame.x, frame.y, frame.width, frame.height);
                    this._verifyBrought(rec, frame, attempt + 1);
                }
            } catch (e) {
                this._host.logError(e);
            }
        });
    }

    _scheduleReleaseVerify() {
        if (this._releaseVerifySource)
            return;
        let attempt = 0;
        const run = () => {
            this._releaseVerifySource = 0;
            if (!this._enabled || this._settings.tilingEnabled || this._grab)
                return;
            attempt++;
            let again = false;
            for (const rec of this._records.values()) {
                const target = rec.releaseTarget;
                if (!target)
                    continue;
                try {
                    if (rec.win.minimized || isHandsOff(rec.win)) {
                        rec.releaseTarget = null;
                        continue;
                    }
                    const actual = rec.win.get_frame_rect();
                    if (sameRect(actual, target, RESIZE_TOLERANCE)) {
                        rec.releaseTarget = null;
                        continue;
                    }
                    this._host.log(`libertar (tentativa ${attempt}): janela ${rec.id} pedido ` +
                        `${target.width}x${target.height}+${target.x}+${target.y}, obtido ` +
                        `${actual.width}x${actual.height}+${actual.x}+${actual.y}`);
                    if (attempt < 3) {
                        rec.win.move_resize_frame(false, target.x, target.y, target.width, target.height);
                        again = true;
                    } else {
                        rec.releaseTarget = null; // desiste: o utilizador manda
                    }
                } catch (e) {
                    this._host.logError(e);
                    rec.releaseTarget = null;
                }
            }
            if (again)
                this._releaseVerifySource = this._host.addTimeout(VERIFY_SETTLE_MS, run);
        };
        this._releaseVerifySource = this._host.addTimeout(VERIFY_MS, run);
    }

    _scheduleVerify() {
        if (this._verifySource)
            return;
        this._verifySource = this._host.addTimeout(VERIFY_MS, () => {
            this._verifySource = 0;
            this._verifyStep(1);
        });
    }

    _verifyStep(step) {
        if (!this._enabled || this._grab || !this._settings.tilingEnabled)
            return;

        const config = this._settings.snapshot();
        let suspicious = false;
        let learned = false;
        let under = false;
        for (const rec of this._records.values()) {
            try {
                if (!rec.lastTarget || rec.win.minimized || isHandsOff(rec.win) || !this._laidOut(rec, config)) {
                    rec.seen = null;
                    continue;
                }
                const actual = rec.win.get_frame_rect();
                const target = rec.lastTarget;
                if (step === 1 && !sameRect(actual, target, RESIZE_TOLERANCE)) {
                    this._host.log(`verificação: janela ${rec.id} (${rec.win.get_wm_class()}) pedido ` +
                        `${target.width}x${target.height}+${target.x}+${target.y}, obtido ` +
                        `${actual.width}x${actual.height}+${actual.x}+${actual.y}`);
                }
                if (step === 1 && (actual.width < target.width - RESIZE_TOLERANCE ||
                    actual.height < target.height - RESIZE_TOLERANCE))
                    under = true;
                const overW = actual.width > target.width + RESIZE_TOLERANCE;
                const overH = actual.height > target.height + RESIZE_TOLERANCE;
                if (!overW && !overH) {
                    rec.seen = null;
                    continue;
                }
                suspicious = true;
                if (step === 1) {
                    rec.seen = {width: actual.width, height: actual.height};
                    // Antes de concluir que a janela "não encolhe", pede-se outra vez: uma app
                    // ocupada (ao acordar da suspensão) pode simplesmente ter ignorado o pedido.
                    rec.win.move_resize_frame(false, target.x, target.y, target.width, target.height);
                    continue;
                }
                const stable = rec.seen &&
                    Math.abs(rec.seen.width - actual.width) <= 1 &&
                    Math.abs(rec.seen.height - actual.height) <= 1;
                if (stable) {
                    const min = rec.minSize ?? {width: 0, height: 0};
                    const next = {
                        width: overW ? Math.max(min.width, actual.width) : min.width,
                        height: overH ? Math.max(min.height, actual.height) : min.height,
                    };
                    if (next.width !== min.width || next.height !== min.height) {
                        rec.minSize = next;
                        learned = true;
                    }
                }
                rec.seen = null;
            } catch (e) {
                this._host.logError(e);
            }
        }

        if (step === 1 && under)
            this._retryUndersized(1);
        if (step === 1 && suspicious) {
            this._verifySource = this._host.addTimeout(VERIFY_SETTLE_MS, () => {
                this._verifySource = 0;
                this._verifyStep(2);
            });
            return;
        }
        if (learned)
            this.scheduleLayout();
    }

    /**
     * O Firefox a arrancar ignora o primeiro pedido de tamanho e fica a meio ecrã até ao
     * relayout tardio. Aqui o pedido repete-se a cada 300 ms (no máximo 12 vezes) enquanto a
     * janela estiver mais pequena do que o planeado.
     */
    _retryUndersized(attempt) {
        if (this._underSource)
            return;
        this._underSource = this._host.addTimeout(UNDER_RETRY_MS, () => {
            this._underSource = 0;
            if (!this._enabled || this._grab || !this._settings.tilingEnabled)
                return;
            const config = this._settings.snapshot();
            let again = false;
            for (const rec of this._records.values()) {
                try {
                    if (!rec.lastTarget || rec.win.minimized || isHandsOff(rec.win) || !this._laidOut(rec, config))
                        continue;
                    const actual = rec.win.get_frame_rect();
                    const t = rec.lastTarget;
                    const recent = rec.mappedAt && this._now() - rec.mappedAt < RECENT_MS;
                    if (recent)
                        again = true; // a app ainda pode mexer-se sozinha: continua a vigiar
                    if (recent && this._settings.debugLog) {
                        this._host.log(`diag ${rec.id} ${rec.win.get_wm_class()}: ` +
                            `alvo ${t.width}x${t.height}+${t.x}+${t.y} frame ${actual.width}x${actual.height}+${actual.x}+${actual.y} ` +
                            `${this._host.actorInfo?.(rec.win) ?? ''}`);
                    }
                    // Actor ficou com escala/deslocamento de uma animação que já acabou (ex.: a do Shell
                    // interrompida): a janela parece encolhida mesmo com o tamanho certo. Repõe.
                    const stuck = recent ? this._host.stuckTransform?.(rec.win) : null;
                    if (stuck) {
                        this._host.log(`vigia: transformação presa em ${rec.win.get_wm_class()} ` +
                            `(escala ${stuck.sx.toFixed(2)}x${stuck.sy.toFixed(2)}), reposta`);
                        this._host.resetTransform?.(rec.win);
                    }
                    const small = actual.width < t.width - RESIZE_TOLERANCE || actual.height < t.height - RESIZE_TOLERANCE;
                    const displaced = Math.abs(actual.x - t.x) > RESIZE_TOLERANCE || Math.abs(actual.y - t.y) > RESIZE_TOLERANCE;
                    if (small || (recent && displaced)) {
                        this._host.log(`vigia: janela ${rec.id} (${rec.win.get_wm_class()}) em ` +
                            `${actual.width}x${actual.height}+${actual.x}+${actual.y}, repete pedido ` +
                            `${t.width}x${t.height}+${t.x}+${t.y}`);
                        rec.win.move_resize_frame(false, t.x, t.y, t.width, t.height);
                        again = true;
                    }
                } catch (e) {
                    this._host.logError(e);
                }
            }
            if (again && attempt < UNDER_RETRIES)
                this._retryUndersized(attempt + 1);
        });
    }

    // ---- Estado para a UI -----------------------------------------------

    _notifyState() {
        if (!this._enabled || this._listeners.size === 0)
            return;
        let manualChanges = false;
        let fullscreen = false;
        let brought = false;
        try {
            manualChanges = this.hasManualChanges();
            fullscreen = this.hasFullscreen();
            brought = this.broughtRecords().length > 0;
        } catch (e) {
            this._host.logError(e);
        }
        if (this._lastState?.manualChanges === manualChanges && this._lastState?.fullscreen === fullscreen &&
            this._lastState?.brought === brought)
            return;
        this._lastState = {manualChanges, fullscreen, brought};
        for (const callback of [...this._listeners]) {
            try {
                callback(this._lastState);
            } catch (e) {
                this._host.logError(e);
            }
        }
    }
}
