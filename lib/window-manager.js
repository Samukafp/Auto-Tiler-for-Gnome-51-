// Coordenação geral: regista janelas, escuta o GNOME e agenda passagens de layout.
//
// Princípios que evitam conflitos com maximização e fullscreen:
//  1. O estado da janela é lido, nunca imposto. Janelas maximizadas ou em
//     fullscreen mantêm o seu lugar lógico no layout, mas a extensão nunca lhes
//     aplica geometria. (Única excepção, opcional: uma janela NOVA que abre
//     maximizada é desmaximizada uma vez, no instante em que abre.)
//  2. Fora de um arrasto do utilizador, não há ligação a size-changed/
//     position-changed: a extensão nunca reage às suas próprias alterações.
//  3. Todas as reacções passam por uma passagem de layout agendada e idempotente.
//  4. Durante um arrasto, só as janelas vizinhas são ajustadas; a arrastada é
//     do utilizador.

import {Animator} from './animator.js';
import {FloatingPolicy} from './floating.js';
import {sameRect} from './layout.js';
import {MonitorTracker} from './monitors.js';
import {pickWorkspace} from './overflow.js';
import {isHandsOff, isManageable, isOverlay} from './policy.js';
import {SignalManager} from './signals.js';
import {TilingEngine} from './tiling.js';
import {buildGroups} from './workspace.js';

const DEBOUNCE_MS = 24;
const LIVE_MS = 12;
const VERIFY_MS = 150;
const VERIFY_SETTLE_MS = 250;
const RESIZE_TOLERANCE = 2;

// Alterações de estado que obrigam a recalcular o layout.
const OPEN_GRACE_MS = 2500;   // fase de abertura em que "maximizada" é estado lembrado pela app
const LATE_UNMAX_DELAY_MS = 30;
const MOVE_THRESHOLD = 24;   // px: abaixo disto, soltar a janela não conta como "arrastar"
const MAX_OPEN_UNMAX = 2;

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
        this._monitors = new MonitorTracker(host, () => this.scheduleLayout());
        this._floating = new FloatingPolicy();
        this._engine = new TilingEngine(message => this._host.log(message));
        this._animator = new Animator(host, settings);

        this._records = new Map();
        this._seq = 0;
        this._source = 0;
        this._liveSource = 0;
        this._verifySource = 0;
        this._inLayout = false;
        this._grab = null;
        this._pendingLearn = null;
        this._enabled = false;
        this._listeners = new Set();
        this._lastState = {manualChanges: false};
    }

    enable() {
        if (this._enabled)
            return;
        this._enabled = true;

        const {display, shellWm, workspaceManager} = this._host;
        this._signals.connect(display, 'window-created', (_d, win) => {
            if (this._register(win))
                this.scheduleLayout();
        });
        // 'map' dá-nos a janela antes da primeira pintura: layout imediato, sem flicker.
        this._signals.connect(shellWm, 'map', (_wm, actor) => this._onMap(actor));
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
        for (const win of this._host.listWindows())
            this._register(win, {existing: true});
        this.layoutNow();
    }

    /** Desliga tudo. Não altera o estado de nenhuma janela. */
    destroy() {
        this._enabled = false;
        for (const key of ['_source', '_liveSource', '_verifySource']) {
            if (this[key]) {
                this._host.removeTimeout(this[key]);
                this[key] = 0;
            }
        }
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
                if ((rec.ratio !== null || rec.groupRatio !== null) && this._workspaceOf(rec) === active && this._inTiling(rec, config))
                    return true;
            } catch (e) {
                this._host.logError(e);
            }
        }
        return false;
    }

    /** Repõe a organização automática original do workspace activo. O tiling continua ligado. */
    restoreLayout() {
        const active = this._activeWorkspaceIndex();
        for (const rec of this._records.values()) {
            try {
                if (this._workspaceOf(rec) === active) {
                    rec.ratio = null;
                    rec.groupRatio = null;
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
    }

    toggleTiling() {
        this._settings.tilingEnabled = !this._settings.tilingEnabled;
    }

    _onSettingChanged(key) {
        this._host.log(`definição alterada: ${key}`);
        if (key === 'tiling-enabled')
            this.layoutNow();
        else
            this.scheduleLayout();
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
            rec.justOpened = true; // o Shell já anima a abertura; não somamos outra por cima
            this._routeOverflow(rec);
        }
        this.layoutNow();
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
            ratio: null,           // divisão com a janela seguinte da coluna, ajustada à mão (null = automática)
            groupRatio: null,      // divisão entre a sua coluna e a seguinte, ajustada à mão
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
                rec.noAnim = name !== 'workspace-changed'; // o Shell anima maximizar/fullscreen
                if (name.startsWith('notify::maximized'))
                    this._onMaximizedWhileOpening(rec);
                this.scheduleLayout();
            }, id);
        }
        this._signals.connect(win, 'notify::minimized', () => this._onMinimizedChanged(rec), id);
        this._signals.connect(win, 'unmanaging', () => this._unregister(id), id);
        return rec;
    }

    _unregister(id) {
        const rec = this._records.get(id);
        if (!rec)
            return;
        this._animator.cancel(rec.win); // fechar durante uma animação: nada fica a meio
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
    _trySwap(grab) {
        try {
            if (!this._settings.swapOnDrag)
                return false;
            const rec = this._records.get(grab.id);
            if (!rec || !rec.lastTarget || rec.win.minimized || isHandsOff(rec.win))
                return false;

            const frame = rec.win.get_frame_rect();
            if (Math.abs(frame.width - grab.width) > RESIZE_TOLERANCE ||
                Math.abs(frame.height - grab.height) > RESIZE_TOLERANCE)
                return false; // foi um redimensionamento
            if (Math.abs(frame.x - grab.x) < MOVE_THRESHOLD && Math.abs(frame.y - grab.y) < MOVE_THRESHOLD)
                return false; // clique ou movimento mínimo

            const config = this._settings.snapshot();
            const group = this._groupOf(rec, config);
            if (!group)
                return false;

            const point = this._host.pointer?.() ??
                {x: frame.x + frame.width / 2, y: frame.y + frame.height / 2};
            const inside = (r, p) => p.x >= r.x && p.x < r.x + r.width && p.y >= r.y && p.y < r.y + r.height;
            const other = group.records.find(r => r !== rec && r.lastTarget && !isHandsOff(r.win) &&
                inside(r.lastTarget, point));
            if (!other)
                return false;

            [rec.seq, other.seq] = [other.seq, rec.seq];
            [rec.ratio, other.ratio] = [other.ratio, rec.ratio];
            [rec.groupRatio, other.groupRatio] = [other.groupRatio, rec.groupRatio];
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
            const config = this._settings.snapshot();
            const moves = this._settings.tilingEnabled
                ? this._layoutAll(config)
                : this._releasePending();
            this._playAnimations(moves);
            if (moves.length > 0 && this._settings.tilingEnabled)
                this._scheduleVerify();
        } catch (e) {
            this._host.logError(e);
        } finally {
            this._inLayout = false;
        }
        this._notifyState();
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
        const groups = buildGroups(participants);
        this._learnPending(groups, config);
        this._host.log(`layout: ${this._records.size} janelas registadas, ${kept.length} em tiling ` +
            `(${participants.length} colocadas), ${groups.size} grupo(s), limite ${this._settings.maxWindows}`);

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
        const cascade = {n: 0}; // janelas sem geometria original não se empilham
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
        const animated = moves.filter(m => !m.rec.noAnim && !m.rec.justOpened);
        for (const {rec} of moves) {
            rec.noAnim = false;
            rec.justOpened = false;
        }
        this._animator.play(animated);
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
        const floating = this._floating.isFloating(rec, config);
        if (floating === null)
            return 'indeterminada';
        if (floating)
            return `flutuante (${rec.override === 'float' ? 'escolha do utilizador' : rec.autoReason})`;
        if (isHandsOff(win))
            return 'tiling (maximizada ou fullscreen: lugar reservado, janela não tocada)';
        return 'tiling';
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
        for (const group of buildGroups(participants).values()) {
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
                const overW = actual.width > target.width + RESIZE_TOLERANCE;
                const overH = actual.height > target.height + RESIZE_TOLERANCE;
                if (!overW && !overH) {
                    rec.seen = null;
                    continue;
                }
                suspicious = true;
                if (step === 1) {
                    rec.seen = {width: actual.width, height: actual.height};
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

    // ---- Estado para a UI -----------------------------------------------

    _notifyState() {
        if (!this._enabled || this._listeners.size === 0)
            return;
        let manualChanges = false;
        try {
            manualChanges = this.hasManualChanges();
        } catch (e) {
            this._host.logError(e);
        }
        if (this._lastState?.manualChanges === manualChanges)
            return;
        this._lastState = {manualChanges};
        for (const callback of [...this._listeners]) {
            try {
                callback(this._lastState);
            } catch (e) {
                this._host.logError(e);
            }
        }
    }
}
