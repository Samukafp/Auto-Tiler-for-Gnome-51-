// Janela de preferências (Libadwaita). Corre fora do GNOME Shell.

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class AutoTilerPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window._settings = settings; // mantém a referência viva enquanto a janela existir
        window.set_default_size(640, 720);

        // Uma aba por assunto (o Adw mostra o seletor de abas no topo).
        const pages = [
            ['Geral', 'preferences-system-symbolic', [this._tilingGroup(settings), this._limitGroup(settings),
                this._behaviourGroup(settings), this._focusResizeGroup(settings)]],
            ['Espaçamentos', 'view-grid-symbolic', [this._gapsGroup(settings)]],
            ['Borda', 'applications-graphics-symbolic', [this._appearanceGroup(settings)]],
            ['Animações', 'media-playback-start-symbolic', [this._animationsGroup(settings)]],
            ['Efeitos', 'applications-science-symbolic', [this._effectsGroup(settings)]],
            ['Janelas', 'window-new-symbolic', [this._floatingGroup(settings)]],
            ['Atalhos', 'input-keyboard-symbolic', [this._shortcutsGroup(settings)]],
        ];
        for (const [title, icon, groups] of pages) {
            const page = new Adw.PreferencesPage({title, icon_name: icon});
            for (const group of groups)
                page.add(group);
            window.add(page);
        }
    }

    _focusResizeGroup(settings) {
        const group = new Adw.PreferencesGroup({
            title: 'Janela trazida durante fullscreen',
            description: 'Com outra janela em fullscreen ou maximizada, uma janela que estava em tiling e é trazida ' +
                '(por exemplo, pela barra de tarefas) aparece flutuante em 16:9, em tamanho normal. ' +
                'Ao sair do fullscreen, tudo volta ao layout.',
        });

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
        const group = new Adw.PreferencesGroup({
            title: 'Limite por ambiente de trabalho',
            description: 'Janelas minimizadas, flutuantes e de outros workspaces não contam para o limite.',
        });

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
        const group = new Adw.PreferencesGroup({
            title: 'Tiling',
            description: 'A maximização e o fullscreen nativos do GNOME nunca são alterados.',
        });

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
        const group = new Adw.PreferencesGroup({
            title: 'Espaçamentos',
            description: 'Aplicam-se apenas a janelas em tiling. Alterações têm efeito imediato.',
        });

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
        const group = new Adw.PreferencesGroup({
            title: 'Comportamento',
        });

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
        sideRow.selected = settings.get_string('open-side') === 'left' ? 1 : 0;
        sideRow.connect('notify::selected', () =>
            settings.set_string('open-side', sideRow.selected === 1 ? 'left' : 'right'));
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

        const STYLE_IDS = ['pill', 'underline', 'square', 'dots', 'plain', 'roman'];
        const styleRow = new Adw.ComboRow({
            title: 'Estilo dos números de workspace',
            subtitle: 'Comprimido, sublinhado, quadrado, pontos, texto simples ou romanos',
            model: Gtk.StringList.new(['Comprimido', 'Sublinhado', 'Quadrado', 'Pontos', 'Texto simples', 'Romanos']),
        });
        styleRow.selected = Math.max(0, STYLE_IDS.indexOf(settings.get_string('workspace-numbers-style')));
        styleRow.connect('notify::selected', () =>
            settings.set_string('workspace-numbers-style', STYLE_IDS[styleRow.selected] ?? 'pill'));
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
        const group = new Adw.PreferencesGroup({
            title: 'Animações',
            description: 'Tudo o que se move ou desvanece. Respeitam também a definição de animações do GNOME.',
        });

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
        const group = new Adw.PreferencesGroup({title: 'Borda da janela focada', description: 'Gradiente entre duas cores que gira à volta da janela.'});

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
            const rgba = new Gdk.RGBA();
            if (!rgba.parse(settings.get_string(key)))
                rgba.parse(fallback);
            button.rgba = rgba;
            button.connect('notify::rgba', () => {
                const c = button.rgba;
                const hex = v => Math.round(v * 255).toString(16).padStart(2, '0');
                settings.set_string(key, `#${hex(c.red)}${hex(c.green)}${hex(c.blue)}`);
            });
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
        const group = new Adw.PreferencesGroup({
            title: 'Janelas flutuantes',
            description: 'Diálogos, janelas transitórias, avisos do sistema e as definições de extensões são sempre flutuantes.',
        });

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
            group.add(row);
        }

        return group;
    }
}
