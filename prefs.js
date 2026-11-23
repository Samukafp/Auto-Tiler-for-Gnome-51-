// Janela de preferências (Libadwaita). Corre fora do GNOME Shell.

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';
import {WORKSPACE_STYLES} from './lib/workspace-styles.js';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

// Predefinições de animação (null = valor por omissão do schema).
const PRESETS = {
    fast: {
        'animations-enabled': false, 'animate-open': false, 'hide-until-sized': true,
        'focus-border-slide': false, 'focus-border-fade-on-focus': false,
    },
    balanced: {
        'animations-enabled': null, 'animation-duration': null, 'animate-open': null, 'hide-until-sized': null,
        'open-fade-duration': null, 'focus-border-slide': null, 'focus-border-slide-duration': null,
        'focus-border-fade-on-focus': null, 'focus-border-fade-duration': null,
    },
    fancy: {
        'animations-enabled': true, 'animation-duration': 320, 'animate-open': true, 'hide-until-sized': true,
        'open-fade-duration': 460, 'focus-border-slide': true, 'focus-border-slide-duration': 300,
    },
};

export default class AutoTilerPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window._settings = settings; // mantém a referência viva enquanto a janela existir
        window.set_default_size(760, 720);

        // Todas as linhas são criadas pelas funções abaixo e depois distribuídas por páginas e
        // grupos pelo título (_layout). Uma linha que não esteja na lista cai em "Outras".
        this._rows = new Map();
        const fullscreenInfo = this._focusResizeGroup(settings);
        this._tilingGroup(settings);
        this._limitGroup(settings);
        this._gapsGroup(settings);
        this._behaviourGroup(settings);
        this._animationsGroup(settings);
        this._appearanceGroup(settings);
        this._floatingGroup(settings);
        const effects = this._effectsGroup(settings);
        const shortcuts = this._shortcutsGroup(settings);

        // Cinco abas curtas: cabem na barra de baixo mesmo numa janela estreita.
        const pages = [
            ['Geral', 'preferences-system-symbolic', [
                this._group('Tiling', 'Como as janelas se organizam', [
                    'Tiling automático', 'Proporção por omissão', 'Lado onde as janelas novas abrem',
                    'Janelas novas entram em tiling', 'Trocar janelas ao arrastar']),
                this._group('Limite por workspace', 'A janela a mais passa para o workspace seguinte', [
                    'Limitar janelas por workspace', 'Máximo de janelas por workspace']),
                this._group('Janelas flutuantes', 'Diálogos, avisos do sistema e as definições de extensões são sempre flutuantes', [
                    'Janelas flutuantes sempre à frente', 'Tiling em reprodutores de vídeo',
                    'Aplicações flutuantes (WM_CLASS / app-id, separados por vírgulas)']),
                this._group('Fora do tiling', null, ['Tamanho das janelas normais (%)']),
                this._fullscreenGroup(fullscreenInfo),
            ]],
            ['Aspeto', 'applications-graphics-symbolic', [
                this._group('Espaços entre janelas', null, [
                    'Usar espaçamentos', 'Espaçamento interno', 'Espaçamento externo',
                    'Sem espaçamentos com uma só janela']),
                this._group('Dock', 'Deixa livre a faixa da dock (como o COSMIC)', [
                    'Deixar espaço para a dock', 'Medir a dock automaticamente', 'Margem extra sobre a dock',
                    'Altura manual para a dock']),
                this._group('Borda da janela focada', 'Gradiente entre duas cores que gira à volta da janela', [
                    'Mostrar borda', 'Esconder a borda com o tiling desligado', 'Espessura (px)',
                    'Arredondamento (px)', 'Cores do wallpaper', 'Primeira cor', 'Segunda cor',
                    'Velocidade do gradiente']),
                this._group('Barra superior', 'Também no ecrã de bloqueio', [
                    'Números de workspace na barra', 'Estilo dos números de workspace',
                    'Botão de restaurar na barra']),
            ]],
            ['Animações', 'media-playback-start-symbolic', [
                this._presetsGroup(settings),
                this._group('Janelas', 'Respeitam também a definição de animações do GNOME', [
                    'Animações', 'Duração das animações (ms)', 'Desmaximizar sem encolher (experimental)',
                    'Esconder a janela até ter o tamanho certo', 'Fade ao abrir janelas novas',
                    'Duração do fade ao abrir (ms)']),
                this._group('Borda', 'Ao mudar o foco entre janelas', [
                    'Borda desliza entre janelas', 'Duração do deslize da borda (ms)',
                    'Fade da borda ao mudar de foco', 'Duração do fade da borda (ms)']),
            ]],
            ['Atalhos', 'input-keyboard-symbolic', [shortcuts]],
            ['Avançado', 'emblem-system-symbolic', [effects, this._advancedGroup(window, settings)]],
        ];
        // Qualquer linha que não tenha sido colocada (nunca se perde uma opção).
        if (this._rows.size > 0) {
            const other = new Adw.PreferencesGroup({title: 'Outras'});
            for (const row of this._rows.values())
                other.add(row);
            this._rows.clear();
            pages[pages.length - 1][2].unshift(other);
        }
        for (const [title, icon, groups] of pages) {
            const page = new Adw.PreferencesPage({title, icon_name: icon});
            for (const group of groups)
                page.add(group);
            window.add(page);
        }
    }

    /** Recolhe as linhas (por título) em vez de as pôr já num grupo. */
    _rec() {
        return {add: row => this._rows.set(row.title, row)};
    }

    /** Grupo com as linhas indicadas, por ordem; títulos desconhecidos são ignorados. */
    _group(title, description, titles) {
        const group = new Adw.PreferencesGroup({title});
        if (description)
            group.set_description(description);
        for (const t of titles) {
            const row = this._rows.get(t);
            if (!row) {
                console.warn(`[auto-tiler] prefs: linha em falta: ${t}`);
                continue;
            }
            this._rows.delete(t);
            group.add(row);
        }
        return group;
    }

    /** Predefinições de animação: um clique ajusta várias opções (podem afinar-se depois). */
    _presetsGroup(settings) {
        const group = new Adw.PreferencesGroup({
            title: 'Predefinições',
            description: 'Um clique ajusta as animações todas; depois podes afinar uma a uma',
        });
        const row = new Adw.ActionRow({
            title: 'Estilo das animações',
            subtitle: 'Rápido: sem efeitos · Equilibrado: o normal · Vistoso: mais suave e com a borda a deslizar',
        });
        const apply = values => () => {
            for (const [key, value] of Object.entries(values)) {
                if (value === null)
                    settings.reset(key);
                else if (typeof value === 'boolean')
                    settings.set_boolean(key, value);
                else
                    settings.set_int(key, value);
            }
        };
        const box = new Gtk.Box({spacing: 6, valign: Gtk.Align.CENTER});
        for (const [label, values] of [
            ['Rápido', PRESETS.fast], ['Equilibrado', PRESETS.balanced], ['Vistoso', PRESETS.fancy],
        ]) {
            const button = new Gtk.Button({label});
            button.connect('clicked', apply(values));
            box.append(button);
        }
        row.add_suffix(box);
        group.add(row);
        return group;
    }

    _fullscreenGroup(info) {
        const group = this._group('Janela trazida durante fullscreen', null, ['Mostrar em tamanho normal', 'A partir de', 'Até']);
        group.set_description(info.description);
        return group;
    }

    _advancedGroup(window, settings) {
        const group = new Adw.PreferencesGroup({title: 'Manutenção'});
        const about = new Adw.ActionRow({
            title: 'Auto Tiler',
            subtitle: `Versão ${this.metadata['version-name'] ?? '?'}`,
        });
        group.add(about);

        const reset = new Adw.ActionRow({
            title: 'Repor todas as definições',
            subtitle: 'Volta aos valores por omissão. Não pode ser desfeito',
        });
        const button = new Gtk.Button({label: 'Repor', valign: Gtk.Align.CENTER, css_classes: ['destructive-action']});
        button.connect('clicked', () => {
            const dialog = new Adw.AlertDialog({
                heading: 'Repor todas as definições?',
                body: 'Todas as opções do Auto Tiler voltam ao valor por omissão.',
            });
            dialog.add_response('cancel', 'Cancelar');
            dialog.add_response('reset', 'Repor');
            dialog.set_response_appearance('reset', Adw.ResponseAppearance.DESTRUCTIVE);
            dialog.connect('response', (_d, response) => {
                if (response !== 'reset')
                    return;
                for (const key of settings.settings_schema.list_keys())
                    settings.reset(key);
            });
            dialog.present(window);
        });
        reset.add_suffix(button);
        group.add(reset);
        return group;
    }

    _focusResizeGroup(settings) {
        const group = this._rec();
        group.description = 'Com outra janela em fullscreen ou maximizada, uma janela que estava em tiling e é trazida ' +
            '(por exemplo, pela barra de tarefas) aparece flutuante em 16:9, em tamanho normal. ' +
            'Ao sair do fullscreen, tudo volta ao layout.';

        const enabled = new Adw.SwitchRow({title: 'Mostrar em tamanho normal'});
        settings.bind('focus-resize-enabled', enabled, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(enabled);

        const hideOff = new Adw.SwitchRow({
            title: 'Esconder a borda com o tiling desligado',
            subtitle: 'A borda só aparece enquanto o tiling está activo',
        });
        settings.bind('focus-border-hide-when-tiling-off', hideOff, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(hideOff);


        for (const [key, title, subtitle] of [
            ['focus-resize-min', 'A partir de', 'Número mínimo de janelas abertas no workspace'],
            ['focus-resize-max', 'Até', 'Número máximo de janelas abertas no workspace'],
        ]) {
            const row = new Adw.SpinRow({
                title,
                subtitle,
                adjustment: new Gtk.Adjustment({lower: 1, upper: 12, step_increment: 1}),
            });
            settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
            enabled.bind_property('active', row, 'sensitive', GObject.BindingFlags.SYNC_CREATE);
            group.add(row);
        }

        return group;
    }

    _effectsGroup(settings) {
        const group = new Adw.PreferencesGroup({
            title: 'Extensões de efeitos',
            description: '⚠ Não actives esta opção se não tiveres estas extensões instaladas. ' +
                'Ligar e desligar extensões altera a lista de extensões activas do GNOME.',
        });

        const known = new Adw.ActionRow({
            title: 'Extensões geridas por omissão',
            subtitle: 'Compiz windows effect (compiz-windows-effect@hermes83.github.com)\n' +
                'Compiz alike magic lamp effect (compiz-alike-magic-lamp-effect@hermes83.github.com)',
        });
        known.subtitle_lines = 0;
        group.add(known);

        const manage = new Adw.SwitchRow({
            title: 'Desligar os efeitos enquanto o tiling está ligado',
            subtitle: 'Com o tiling desligado, as extensões voltam a ligar-se',
        });
        settings.bind('manage-effect-extensions', manage, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(manage);

        const fullscreen = new Adw.SwitchRow({
            title: 'Ligar os efeitos em fullscreen',
            subtitle: 'Mesmo com o tiling ligado, ligam-se quando uma janela entra em fullscreen e ' +
                'desligam-se ao sair. Pode deixar o computador mais lento.',
        });
        settings.bind('effects-in-fullscreen', fullscreen, 'active', Gio.SettingsBindFlags.DEFAULT);
        manage.bind_property('active', fullscreen, 'sensitive', GObject.BindingFlags.SYNC_CREATE);
        group.add(fullscreen);

        const list = new Adw.EntryRow({
            title: 'Extensões (UUIDs separados por vírgulas)',
            show_apply_button: true,
            text: settings.get_strv('effect-extensions').join(', '),
        });
        list.connect('apply', () => {
            settings.set_strv('effect-extensions', list.text.split(',').map(s => s.trim()).filter(Boolean));
        });
        manage.bind_property('active', list, 'sensitive', GObject.BindingFlags.SYNC_CREATE);
        group.add(list);

        return group;
    }

    _limitGroup(settings) {
        const group = this._rec();

        const enabled = new Adw.SwitchRow({
            title: 'Limitar janelas por workspace',
            subtitle: 'Desligado: todas as janelas ficam no mesmo workspace, sem limite',
        });
        settings.bind('limit-enabled', enabled, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(enabled);

        const max = new Adw.SpinRow({
            title: 'Máximo de janelas por workspace',
            subtitle: 'A janela seguinte vai para o workspace seguinte com espaço',
            adjustment: new Gtk.Adjustment({lower: 1, upper: 12, step_increment: 1}),
        });
        settings.bind('max-windows', max, 'value', Gio.SettingsBindFlags.DEFAULT);
        enabled.bind_property('active', max, 'sensitive', GObject.BindingFlags.SYNC_CREATE);
        group.add(max);

        return group;
    }

    _tilingGroup(settings) {
        const group = this._rec();

        const enabled = new Adw.SwitchRow({
            title: 'Tiling automático',
            subtitle: 'Organiza as janelas à medida que abres e fechas aplicações',
        });
        settings.bind('tiling-enabled', enabled, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(enabled);

        const ratio = new Adw.SpinRow({
            title: 'Proporção por omissão',
            subtitle: 'Fracção do espaço dada à janela mais antiga em cada divisão',
            digits: 2,
            adjustment: new Gtk.Adjustment({lower: 0.2, upper: 0.8, step_increment: 0.05}),
        });
        settings.bind('default-ratio', ratio, 'value', Gio.SettingsBindFlags.DEFAULT);
        group.add(ratio);

        return group;
    }

    _gapsGroup(settings) {
        const group = this._rec();

        const enabled = new Adw.SwitchRow({title: 'Usar espaçamentos'});
        settings.bind('gaps-enabled', enabled, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(enabled);

        for (const [key, title, subtitle] of [
            ['inner-gap', 'Espaçamento interno', 'Entre janelas vizinhas (px)'],
            ['outer-gap', 'Espaçamento externo', 'Junto às extremidades do ecrã (px)'],
        ]) {
            const row = new Adw.SpinRow({
                title,
                subtitle,
                adjustment: new Gtk.Adjustment({lower: 0, upper: 64, step_increment: 1}),
            });
            settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
            enabled.bind_property('active', row, 'sensitive', GObject.BindingFlags.SYNC_CREATE);
            group.add(row);
        }

        const dock = new Adw.SwitchRow({
            title: 'Deixar espaço para a dock',
            subtitle: 'As janelas em tiling deixam livre a faixa inferior do ecrã (como o COSMIC)',
        });
        settings.bind('dock-reserve', dock, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(dock);
        const dockAuto = new Adw.SwitchRow({
            title: 'Medir a dock automaticamente',
            subtitle: 'Usa a altura real da Dash to Dock (se estiver em baixo); senão usa o valor abaixo',
        });
        settings.bind('dock-reserve-auto', dockAuto, 'active', Gio.SettingsBindFlags.DEFAULT);
        dock.bind_property('active', dockAuto, 'sensitive', GObject.BindingFlags.SYNC_CREATE);
        group.add(dockAuto);
        const dockMargin = new Adw.SpinRow({
            title: 'Margem extra sobre a dock',
            subtitle: 'Em píxeis, somada à altura medida (espaço para a ampliação dos ícones)',
            adjustment: new Gtk.Adjustment({lower: 0, upper: 200, step_increment: 2}),
        });
        settings.bind('dock-reserve-margin', dockMargin, 'value', Gio.SettingsBindFlags.DEFAULT);
        dock.bind_property('active', dockMargin, 'sensitive', GObject.BindingFlags.SYNC_CREATE);
        group.add(dockMargin);
        const dockSize = new Adw.SpinRow({
            title: 'Altura manual para a dock',
            subtitle: 'Em píxeis, na parte de baixo do ecrã (usada se não houver dock a medir)',
            adjustment: new Gtk.Adjustment({lower: 0, upper: 400, step_increment: 2}),
        });
        settings.bind('dock-reserve-size', dockSize, 'value', Gio.SettingsBindFlags.DEFAULT);
        dock.bind_property('active', dockSize, 'sensitive', GObject.BindingFlags.SYNC_CREATE);
        group.add(dockSize);

        return group;
    }

    _behaviourGroup(settings) {
        const group = this._rec();

        const size = new Adw.SpinRow({
            title: 'Tamanho das janelas normais (%)',
            subtitle: 'Largura em % do ecrã (proporção 16:10) das janelas libertadas ao desligar o tiling ' +
                'ou trazidas durante um fullscreen',
            adjustment: new Gtk.Adjustment({lower: 25, upper: 70, step_increment: 1}),
        });
        settings.bind('normal-window-size', size, 'value', Gio.SettingsBindFlags.DEFAULT);
        group.add(size);

        const unmax = new Adw.SwitchRow({
            title: 'Janelas novas entram em tiling',
            subtitle: 'Se uma aplicação abrir maximizada, é desmaximizada uma só vez ao abrir. ' +
                'Depois disso, maximizar é sempre decisão tua. O fullscreen nunca é alterado.',
        });
        settings.bind('unmaximize-on-open', unmax, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(unmax);

        const swap = new Adw.SwitchRow({
            title: 'Trocar janelas ao arrastar',
            subtitle: 'Arrasta uma janela em tiling para cima de outra para trocarem de lugar',
        });
        settings.bind('swap-on-drag', swap, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(swap);

        const smart = new Adw.SwitchRow({
            title: 'Sem espaçamentos com uma só janela',
            subtitle: 'Uma janela sozinha ocupa toda a área útil (não é maximizada)',
        });
        settings.bind('smart-gaps', smart, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(smart);

        const sideRow = new Adw.ComboRow({
            title: 'Lado onde as janelas novas abrem',
            subtitle: 'As janelas novas entram à direita ou à esquerda das que já existem',
            model: Gtk.StringList.new(['Direita', 'Esquerda']),
        });
        const sideIndex = () => (settings.get_string('open-side') === 'left' ? 1 : 0);
        sideRow.selected = sideIndex();
        sideRow.connect('notify::selected', () => {
            const side = sideRow.selected === 1 ? 'left' : 'right';
            if (side !== settings.get_string('open-side'))
                settings.set_string('open-side', side);
        });
        settings.connect('changed::open-side', () => {
            if (sideRow.selected !== sideIndex())
                sideRow.selected = sideIndex();
        });
        group.add(sideRow);

        const onTop = new Adw.SwitchRow({
            title: 'Janelas flutuantes sempre à frente',
            subtitle: 'Ficam por cima das janelas em tiling, mesmo ao abrir ou mexer numa delas',
        });
        settings.bind('floating-on-top', onTop, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(onTop);

        const wsNumbers = new Adw.SwitchRow({
            title: 'Números de workspace na barra',
            subtitle: 'Estilo Hyprland: 1 2 3 com o activo realçado, em vez dos pontos do GNOME',
        });
        settings.bind('workspace-numbers', wsNumbers, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(wsNumbers);

        const styleRow = new Adw.ComboRow({
            title: 'Estilo dos números de workspace',
            subtitle: 'Muda também no ecrã de bloqueio',
            model: Gtk.StringList.new(WORKSPACE_STYLES.map(([, name]) => name)),
        });
        const styleIndex = () => Math.max(0, WORKSPACE_STYLES.findIndex(([id]) => id === settings.get_string('workspace-numbers-style')));
        styleRow.selected = styleIndex();
        styleRow.connect('notify::selected', () => {
            const id = WORKSPACE_STYLES[styleRow.selected]?.[0] ?? 'pill';
            if (id !== settings.get_string('workspace-numbers-style'))
                settings.set_string('workspace-numbers-style', id);
        });
        // Repor/predefinições mudam a chave por fora: a linha acompanha.
        settings.connect('changed::workspace-numbers-style', () => {
            if (styleRow.selected !== styleIndex())
                styleRow.selected = styleIndex();
        });
        settings.bind('workspace-numbers', styleRow, 'sensitive', Gio.SettingsBindFlags.GET);
        group.add(styleRow);

        const restoreBtn = new Adw.SwitchRow({
            title: 'Botão de restaurar na barra',
            subtitle: 'Aparece só quando há alterações manuais ao layout',
        });
        settings.bind('show-restore-button', restoreBtn, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(restoreBtn);

        return group;
    }

    _animationsGroup(settings) {
        const group = this._rec();

        const anim = new Adw.SwitchRow({
            title: 'Animações',
            subtitle: 'Respeita também a definição de animações do GNOME',
        });
        settings.bind('animations-enabled', anim, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(anim);

        const fastUnmax = new Adw.SwitchRow({
            title: 'Desmaximizar sem encolher (experimental)',
            subtitle: 'Reposiciona a janela antes do frame seguinte. Se o desktop se comportar mal, desliga',
        });
        settings.bind('fast-unmaximize', fastUnmax, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(fastUnmax);

        const duration = new Adw.SpinRow({
            title: 'Duração das animações (ms)',
            adjustment: new Gtk.Adjustment({lower: 50, upper: 600, step_increment: 10}),
        });
        settings.bind('animation-duration', duration, 'value', Gio.SettingsBindFlags.DEFAULT);
        anim.bind_property('active', duration, 'sensitive', GObject.BindingFlags.SYNC_CREATE);
        group.add(duration);


        const slide = new Adw.SwitchRow({
            title: 'Borda desliza entre janelas',
            subtitle: 'Ao mudar o foco, a borda arrasta-se da janela anterior para a nova (em vez do fade)',
        });
        settings.bind('focus-border-slide', slide, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(slide);

        const slideMs = new Adw.SpinRow({
            title: 'Duração do deslize da borda (ms)',
            adjustment: new Gtk.Adjustment({lower: 80, upper: 800, step_increment: 10}),
        });
        settings.bind('focus-border-slide-duration', slideMs, 'value', Gio.SettingsBindFlags.DEFAULT);
        slide.bind_property('active', slideMs, 'sensitive', GObject.BindingFlags.SYNC_CREATE);
        group.add(slideMs);

        const openFade = new Adw.SpinRow({
            title: 'Duração do fade ao abrir (ms)',
            subtitle: 'Quanto tempo demora a janela nova a aparecer',
            adjustment: new Gtk.Adjustment({lower: 100, upper: 1500, step_increment: 10}),
        });
        settings.bind('open-fade-duration', openFade, 'value', Gio.SettingsBindFlags.DEFAULT);
        group.add(openFade);

        const borderFade = new Adw.SpinRow({
            title: 'Duração do fade da borda (ms)',
            adjustment: new Gtk.Adjustment({lower: 80, upper: 1000, step_increment: 10}),
        });
        settings.bind('focus-border-fade-duration', borderFade, 'value', Gio.SettingsBindFlags.DEFAULT);
        group.add(borderFade);

        const fadeFocus = new Adw.SwitchRow({
            title: 'Fade da borda ao mudar de foco',
            subtitle: 'Desligado: mudar de foco entre janelas é instantâneo. Janelas novas fazem sempre fade',
        });
        settings.bind('focus-border-fade-on-focus', fadeFocus, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(fadeFocus);

        const hideSized = new Adw.SwitchRow({
            title: 'Esconder a janela até ter o tamanho certo',
            subtitle: 'Ao abrir, a janela fica invisível (até ~1 s) até chegar ao tamanho do tiling, em vez de se ver pequena e depois crescer. Funciona mesmo com as animações desligadas',
        });
        settings.bind('hide-until-sized', hideSized, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(hideSized);

        const fadeBorderNote = new Adw.SwitchRow({
            title: 'Fade ao abrir janelas novas',
            subtitle: 'Desligado: a janela aparece de uma vez (sem desvanecer) quando já tem o tamanho certo',
        });
        settings.bind('animate-open', fadeBorderNote, 'active', Gio.SettingsBindFlags.DEFAULT);
        hideSized.bind_property('active', fadeBorderNote, 'sensitive', GObject.BindingFlags.SYNC_CREATE);
        group.add(fadeBorderNote);

        return group;
    }

    _appearanceGroup(settings) {
        const group = this._rec();

        const enabled = new Adw.SwitchRow({title: 'Mostrar borda'});
        settings.bind('focus-border-enabled', enabled, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(enabled);

        for (const [key, title, upper] of [
            ['focus-border-width', 'Espessura (px)', 10],
            ['focus-border-radius', 'Arredondamento (px)', 32],
        ]) {
            const row = new Adw.SpinRow({
                title,
                adjustment: new Gtk.Adjustment({lower: 1, upper, step_increment: 1}),
            });
            settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
            enabled.bind_property('active', row, 'sensitive', GObject.BindingFlags.SYNC_CREATE);
            group.add(row);
        }

        const wallpaper = new Adw.SwitchRow({
            title: 'Cores do wallpaper',
            subtitle: 'Usa tons do wallpaper actual, suavizados para ficarem sempre visíveis (um wallpaper preto dá cinza, não preto)',
        });
        settings.bind('focus-border-wallpaper', wallpaper, 'active', Gio.SettingsBindFlags.DEFAULT);
        enabled.bind_property('active', wallpaper, 'sensitive', GObject.BindingFlags.SYNC_CREATE);
        group.add(wallpaper);

        const manualRows = [];
        for (const [key, title, fallback] of [
            ['focus-border-color', 'Primeira cor', '#33d17a'],
            ['focus-border-color2', 'Segunda cor', '#3584e4'],
        ]) {
            const row = new Adw.ActionRow({title});
            const button = new Gtk.ColorDialogButton({
                valign: Gtk.Align.CENTER,
                dialog: new Gtk.ColorDialog(),
            });
            let syncing = false;
            const load = () => {
                const rgba = new Gdk.RGBA();
                if (!rgba.parse(settings.get_string(key)))
                    rgba.parse(fallback);
                syncing = true;
                button.rgba = rgba;
                syncing = false;
            };
            load();
            button.connect('notify::rgba', () => {
                if (syncing)
                    return;
                const c = button.rgba;
                const hex = v => Math.round(v * 255).toString(16).padStart(2, '0');
                const value = `#${hex(c.red)}${hex(c.green)}${hex(c.blue)}`;
                if (value !== settings.get_string(key))
                    settings.set_string(key, value);
            });
            settings.connect(`changed::${key}`, load); // "Repor" muda a chave por fora
            row.add_suffix(button);
            manualRows.push(row);
            group.add(row);
        }
        // As cores manuais só contam sem as do wallpaper.
        const syncManual = () => {
            for (const row of manualRows)
                row.sensitive = enabled.active && !wallpaper.active;
        };
        enabled.connect('notify::active', syncManual);
        wallpaper.connect('notify::active', syncManual);
        syncManual();

        const speed = new Adw.SpinRow({
            title: 'Velocidade do gradiente',
            subtitle: '0 = parado; 10 = muito rápido. Com as duas cores iguais não há movimento.',
            adjustment: new Gtk.Adjustment({lower: 0, upper: 10, step_increment: 1}),
        });
        settings.bind('focus-border-speed', speed, 'value', Gio.SettingsBindFlags.DEFAULT);
        enabled.bind_property('active', speed, 'sensitive', GObject.BindingFlags.SYNC_CREATE);
        group.add(speed);

        return group;
    }

    _floatingGroup(settings) {
        const group = this._rec();

        const video = new Adw.SwitchRow({
            title: 'Tiling em reprodutores de vídeo',
            subtitle: 'Desligado: Celluloid, VLC, mpv, Totem e semelhantes abrem como janelas flutuantes',
        });
        settings.bind('tile-video-players', video, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(video);

        const classes = new Adw.EntryRow({
            title: 'Aplicações flutuantes (WM_CLASS / app-id, separados por vírgulas)',
            show_apply_button: true,
            text: settings.get_strv('float-wm-classes').join(', '),
        });
        classes.connect('apply', () => {
            const list = classes.text.split(',').map(s => s.trim()).filter(Boolean);
            settings.set_strv('float-wm-classes', list);
        });
        settings.connect('changed::float-wm-classes', () => {
            const text = settings.get_strv('float-wm-classes').join(', ');
            if (classes.text !== text)
                classes.text = text;
        });
        group.add(classes);

        return group;
    }

    _shortcutsGroup(settings) {
        const group = new Adw.PreferencesGroup({
            title: 'Atalhos',
            description: 'Formato GTK, por exemplo <Super>f ou <Control><Alt>t.',
        });

        for (const [key, title] of [
            ['toggle-float', 'Alternar janela flutuante / em tiling'],
            ['toggle-tiling', 'Activar / desactivar o tiling'],
            ['restore-layout', 'Restaurar a organização original (vazio = sem atalho)'],
            ['swap-left', 'Trocar a janela com a da esquerda'],
            ['swap-right', 'Trocar a janela com a da direita'],
            ['swap-up', 'Trocar a janela com a de cima'],
            ['swap-down', 'Trocar a janela com a de baixo'],
            ['focus-next', 'Alternar o foco entre as janelas em tiling'],
            ['toggle-pin', 'Fixar / desafixar a janela em todos os workspaces'],
        ]) {
            const row = new Adw.EntryRow({
                title,
                show_apply_button: true,
                text: settings.get_strv(key)[0] ?? '',
            });
            row.connect('apply', () => {
                const text = row.text.trim();
                if (text === '') {
                    settings.set_strv(key, []);
                    row.remove_css_class('error');
                    return;
                }
                const [valid] = Gtk.accelerator_parse(text);
                if (valid) {
                    settings.set_strv(key, [text]);
                    row.remove_css_class('error');
                } else {
                    row.add_css_class('error');
                }
            });
            settings.connect(`changed::${key}`, () => {
                const text = settings.get_strv(key)[0] ?? '';
                if (row.text !== text)
                    row.text = text;
            });
            group.add(row);
        }

        return group;
    }
}
