// Predicados sobre o estado de uma Meta.Window. São a única fonte de verdade
// sobre "esta janela é minha para mover?". Nenhuma função aqui altera a janela.

/**
 * Janelas em fullscreen ou maximizadas (em qualquer eixo) pertencem ao GNOME.
 * A extensão não as move, não as redimensiona e não lhes aplica gaps.
 * Maximização parcial (ex.: tiling nativo com Super+Esq/Dir) também conta:
 * foi uma escolha explícita do utilizador.
 */
export function isHandsOff(win) {
    return Boolean(
        win.is_fullscreen() ||
        win.maximized_horizontally ||
        win.maximized_vertically
    );
}

/**
 * Janela que cobre o ecrã (fullscreen ou maximizada nos dois eixos): enquanto
 * existir, as outras janelas do mesmo workspace/monitor ficam temporariamente
 * flutuantes (o utilizador pode movê-las à vontade) e voltam ao layout depois.
 */
export function isOverlay(win) {
    return Boolean(win.is_fullscreen() || (win.maximized_horizontally && win.maximized_vertically));
}

/**
 * Janelas de sistema e de configuração que nunca entram em tiling: definições de
 * extensões, avisos/autenticações do sistema. (WM_CLASS / app-id em minúsculas.)
 */
export const SYSTEM_FLOAT_CLASSES = [
    'org.gnome.shell.extensions', 'org.gnome.extensions', 'gnome-extensions-prefs', 'gnome-extensions-app',
    'org.gnome.shell.portal.helper', 'polkit-gnome-authentication-agent-1', 'org.gnome.polkit',
    'gcr-prompter', 'gcr-viewer', 'pinentry', 'pinentry-gnome3', 'update-notifier', 'gnome-initial-setup',
    'xdg-desktop-portal-gnome', 'org.freedesktop.impl.portal.desktop.gnome',
    'blueman-manager-applet', 'nm-connection-editor',
];

/** Reprodutores de vídeo: por omissão não entram em tiling (opção "Tiling em reprodutores de vídeo"). */
export const VIDEO_PLAYER_CLASSES = [
    'io.github.celluloid_player.celluloid', 'celluloid', 'gnome-mpv', 'mpv', 'io.mpv.mpv', 'vlc', 'org.videolan.vlc',
    'org.gnome.totem', 'totem', 'org.gnome.showtime', 'showtime', 'org.kde.haruna', 'haruna', 'smplayer',
    'info.smplayer.smplayer', 'parole', 'com.github.rafostar.clapper', 'clapper', 'kaffeine', 'dragonplayer',
    'org.kde.dragonplayer', 'mplayer', 'io.github.iwalton3.jellyfin-media-player', 'stremio', 'org.jellyfin.jellyfinmediaplayer',
];

/** Só janelas "normais" e geridas pelo compositor entram no registo. */
export function isManageable(win, normalType) {
    if (!win)
        return false;
    if (win.get_window_type() !== normalType)
        return false;
    if (win.is_override_redirect())
        return false;
    if (win.is_skip_taskbar())
        return false;
    return true;
}

/**
 * Regras automáticas de janela flutuante. Devolve o motivo, ou null se a
 * janela deve entrar em tiling. Só deve ser chamada com a janela fora de
 * fullscreen/maximização, para que o tamanho e `allows_resize` sejam os reais.
 */
export function classKey(win) {
    return [win.get_wm_class(), win.get_wm_class_instance(), win.get_gtk_application_id()]
        .filter(Boolean).map(c => c.toLowerCase()).join('|');
}

/**
 * «Guardar como…» / «Abrir ficheiro» vindos do portal do GNOME: são uma janela do Nautilus (ou do
 * próprio portal) sem pai, por isso só o título os distingue de uma janela normal do Nautilus.
 */
const FILE_CHOOSER_CLASSES = new Set([
    'org.gnome.nautilus', 'nautilus', 'xdg-desktop-portal-gnome',
    'org.freedesktop.impl.portal.desktop.gnome', 'xdg-desktop-portal-gtk',
    'org.freedesktop.impl.portal.desktop.gtk', 'xdg-desktop-portal-kde',
    'org.freedesktop.impl.portal.desktop.kde', 'kdialog',
]);
const FILE_CHOOSER_START = /^(save|open|select|choose|upload|attach|guardar|salvar|abrir|seleccionar|selecionar|escolher|carregar|anexar)(?:\s|[.….:–—-]|$)/i;
const FILE_CHOOSER_SPECIFIC = /^(?:(?:save|guardar|salvar) (?:as|como)\b|(?:save|open|select|choose|upload|attach|guardar|salvar|abrir|seleccionar|selecionar|escolher|carregar|anexar)[: ]{1,2}(?:(?:a|the|um|uma|o|os|as) )?(?:file|folder|location|attachment|ficheiro|arquivo|pasta|local|anexo)s?\b)/i;
const FILE_CHOOSER_ROLE = /^(?:gtk[-_:]?)?file[-_ ]?chooser(?:[-_ ]?(?:dialog|native))?$/i;

export function isFileChooser(win) {
    const title = (win.get_title?.() ?? '').trim();
    if (FILE_CHOOSER_ROLE.test(win.get_role?.() ?? ''))
        return true;
    const classes = classKey(win).split('|');
    const portal = classes.some(c => FILE_CHOOSER_CLASSES.has(c) && c !== 'nautilus' && c !== 'org.gnome.nautilus');
    const nautilus = classes.some(c => c === 'nautilus' || c === 'org.gnome.nautilus');
    return (portal && FILE_CHOOSER_START.test(title)) ||
        ((nautilus || win.get_transient_for?.()) && FILE_CHOOSER_SPECIFIC.test(title)) ||
        (Boolean(win.get_transient_for?.()) && /^(?:save|open|guardar|salvar|abrir)[.…]*$/i.test(title));
}

export function autoFloatReason(win, config) {
    if (win.get_transient_for())
        return 'transient';
    if (win.is_attached_dialog())
        return 'dialog';
    if (isFileChooser(win))
        return 'file-chooser';
    if (win.is_on_all_workspaces())
        return 'sticky';
    if (!win.allows_resize())
        return 'fixed-size';

    const classes = [win.get_wm_class(), win.get_wm_class_instance(), win.get_gtk_application_id()]
        .filter(Boolean)
        .map(c => c.toLowerCase());
    if (classes.some(c => config.floatClasses.includes(c)))
        return 'class';
    if (classes.some(c => SYSTEM_FLOAT_CLASSES.includes(c)))
        return 'system';
    if (!config.tileVideoPlayers && classes.some(c => VIDEO_PLAYER_CLASSES.includes(c)))
        return 'video-player';

    // Sem regra de "janela pequena": o tamanho no instante em que a janela aparece
    // é provisório (o app ainda não recebeu o tamanho final) e a decisão é permanente.

    return null;
}
