// Gestão central de ligações a sinais. Tudo o que é ligado aqui é desligado
// por grupo (por exemplo, por janela) ou de uma só vez em disable().

export class SignalManager {
    constructor() {
        this._entries = [];
    }

    /**
     * @param {object} obj Objecto GObject (ou equivalente) com connect/disconnect.
     * @param {string} name Nome do sinal.
     * @param {Function} callback
     * @param {*} [group] Chave opcional para desligar vários sinais em conjunto.
     */
    connect(obj, name, callback, group = null) {
        const id = obj.connect(name, callback);
        this._entries.push({obj, id, group});
        return id;
    }

    disconnectGroup(group) {
        this._entries = this._entries.filter(entry => {
            if (entry.group !== group)
                return true;
            this._safeDisconnect(entry);
            return false;
        });
    }

    disconnectAll() {
        for (const entry of this._entries)
            this._safeDisconnect(entry);
        this._entries = [];
    }

    get size() {
        return this._entries.length;
    }

    _safeDisconnect({obj, id}) {
        try {
            obj.disconnect(id);
        } catch {
            // O objecto pode já ter sido destruído; não há nada a limpar.
        }
    }
}
