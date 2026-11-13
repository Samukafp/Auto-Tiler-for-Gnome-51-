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

        const page = new Adw.PreferencesPage({
            title: 'Geral',
            icon_name: 'view-grid-symbolic',
        });
        window.add(page);

        page.add(this._tilingGroup(settings));
        page.add(this._gapsGroup(settings));
        page.add(this._behaviourGroup(settings));
        page.add(this._floatingGroup(settings));
        page.add(this._appearanceGroup(settings));
        page.add(this._shortcutsGroup(settings));
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

        return group;
    }

    _behaviourGroup(settings) {
        const group = new Adw.PreferencesGroup({
            title: 'Comportamento',
            description: 'Janelas minimizadas, flutuantes e de outros workspaces não contam para o limite.',
        });

        const max = new Adw.SpinRow({
            title: 'Máximo de janelas por workspace',
            subtitle: 'A janela seguinte vai para o workspace seguinte com espaço',
            adjustment: new Gtk.Adjustment({lower: 1, upper: 12, step_increment: 1}),
        });
        settings.bind('max-windows', max, 'value', Gio.SettingsBindFlags.DEFAULT);
        group.add(max);

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

        const anim = new Adw.SwitchRow({
            title: 'Animações',
            subtitle: 'Respeita também a definição de animações do GNOME',
        });
        settings.bind('animations-enabled', anim, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(anim);

        return group;
    }

    _appearanceGroup(settings) {
        const group = new Adw.PreferencesGroup({title: 'Borda da janela focada'});

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

        const color = new Adw.ActionRow({title: 'Cor'});
        const button = new Gtk.ColorDialogButton({
            valign: Gtk.Align.CENTER,
            dialog: new Gtk.ColorDialog(),
        });
        const rgba = new Gdk.RGBA();
        if (rgba.parse(settings.get_string('focus-border-color')))
            button.rgba = rgba;
        button.connect('notify::rgba', () => {
            const c = button.rgba;
            const hex = v => Math.round(v * 255).toString(16).padStart(2, '0');
            settings.set_string('focus-border-color', `#${hex(c.red)}${hex(c.green)}${hex(c.blue)}`);
        });
        color.add_suffix(button);
        enabled.bind_property('active', color, 'sensitive', GObject.BindingFlags.SYNC_CREATE);
        group.add(color);

        return group;
    }

    _floatingGroup(settings) {
        const group = new Adw.PreferencesGroup({
            title: 'Janelas flutuantes',
            description: 'Diálogos e janelas transitórias são sempre flutuantes.',
        });

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
