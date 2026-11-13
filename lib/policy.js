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

    // Sem regra de "janela pequena": o tamanho no instante em que a janela aparece
    // é provisório (o app ainda não recebeu o tamanho final) e a decisão é permanente.

    return null;
}
