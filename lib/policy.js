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

export function autoFloatReason(win, config) {
    if (win.get_transient_for())
        return 'transient';
    if (win.is_attached_dialog())
        return 'dialog';
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
