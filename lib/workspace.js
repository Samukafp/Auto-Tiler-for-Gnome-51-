// Agrupamento de janelas por (workspace, monitor). Cada grupo tem o seu
// próprio layout, independente dos outros.

/**
 * @param {{id:*, seq:number, win:object}[]} records
 * @returns {Map<string, {key:string, workspace:number, monitor:number, records:object[]}>}
 *   Os registos de cada grupo ficam ordenados por antiguidade (seq).
 */
export function buildGroups(records, newestFirst = false) {
    const groups = new Map();
    const sorted = [...records].sort((a, b) => (newestFirst ? b.seq - a.seq : a.seq - b.seq));

    for (const rec of sorted) {
        const workspace = rec.win.get_workspace();
        if (!workspace)
            continue;
        const monitor = rec.win.get_monitor();
        if (monitor < 0)
            continue;

        const key = `${workspace.index()}:${monitor}`;
        let group = groups.get(key);
        if (!group) {
            group = {key, workspace: workspace.index(), monitor, records: []};
            groups.set(key, group);
        }
        group.records.push(rec);
    }
    return groups;
}
