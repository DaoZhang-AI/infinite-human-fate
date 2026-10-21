/** Persistent identity and user edits. Derived scores still replay the current chat. */
export function userAliases(userName) {
    return new Set([userName, '你', '我', 'user', 'User', '{{user}}'].filter(Boolean));
}

export function allowedPerson(memory, name, userName, includeUser = false) {
    return !!name?.trim() && !memory.personBlocks?.[name]?.blocked
        && (includeUser || !userAliases(userName).has(name));
}

export function rememberPeople(memory, names, userName, includeUser = false) {
    memory.dossiers ??= {};
    let added = 0;
    for (const name of names) {
        if (!allowedPerson(memory, name, userName, includeUser) || memory.dossiers[name]) continue;
        memory.dossiers[name] = { name, created: Date.now(), updated: Date.now() };
        added++;
    }
    return added;
}

/** A score written beside an exact known name is an absolute score, not a delta.
 * Latest explicit score wins; compensate earlier ledger deltas when choosing the baseline. */
export function inheritAffinity(memory, rows, chat, names) {
    memory.affinityStart ??= {};
    let count = 0;
    for (const name of names) {
        const previous = memory.affinityStart[name];
        if (previous?.source === 'manual') continue;
        const safe = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const patterns = [new RegExp(`${safe}[^\\n<>]{0,30}?好感(?:度)?[^\\d+\\-\\n]{0,8}([+-]?\\d{1,3})(?!\\d)`, 'g'),
            new RegExp(`好感(?:度)?[^\\n<>]{0,10}?${safe}[^\\d+\\-\\n]{0,8}([+-]?\\d{1,3})(?!\\d)`, 'g')];
        let latest;
        for (const row of rows.filter(r => !r.isUser)) {
            const text = String(chat[row.index]?.mes ?? '').replace(/<ihf-ledger>[\s\S]*?<\/ihf-ledger>/g, '');
            for (const pattern of patterns) {
                for (const match of text.matchAll(pattern)) {
                    const value = Number(match[1]);
                    if (value >= -100 && value <= 100) latest = { value, index: row.index, fp: row.fp };
                }
            }
        }
        if (!latest) continue;
        if (previous?.source === 'inherited' && previous.afterFp === latest.fp && previous.value === latest.value) continue;
        // Existing deltas are already folded; offset through the source floor only.
        // Use a checkpoint instead of subtracting: clamps make inverse addition unreliable.
        memory.affinityStart[name] = { value: latest.value, why: `继承第 ${latest.index} 层已有好感`,
            source: 'inherited', afterFp: latest.fp };
        count++;
    }
    return count;
}

export function eligibleSummaryIndices(rows, delay = 2) {
    // Existing behavior excludes the newest AI reply. Delay two additional message floors.
    const newest = rows.filter(r => !r.isUser && !r.hidden).at(-1)?.index ?? -1;
    return rows.filter(r => !r.isUser && !r.hidden && r.index < newest - delay).map(r => r.index);
}

export function personEvents(memory, rows, name) {
    return rows.filter(r => !r.isUser && r.record).flatMap(r => {
        const rec = r.record;
        const related = [...(rec.present ?? []), ...(rec.names ?? []),
            ...['affinity', 'traits', 'emotions', 'breaks'].flatMap(k => (rec[k] ?? []).map(x => x.name))].includes(name)
            || rec.summary?.includes(name);
        if (!related) return [];
        const id = r.fp;
        const edit = memory.dossiers?.[name]?.events?.[id];
        return edit?.deleted ? [] : [{ id, index: r.index, day: r.day, text: edit?.text ?? rec.summary ?? '',
            traits: (rec.traits ?? []).filter(x => x.name === name) }];
    });
}

export function replaceUser(text, userName, replacement = '{{user}}') {
    const aliases = [...new Set([userName, '{{user}}', 'User', 'user'].filter(Boolean))]
        .sort((a, b) => b.length - a.length).map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    return String(text ?? '').replace(new RegExp(aliases.join('|'), 'g'), () => replacement);
}

/** Versioned, credential-free handoff for a future card editor. Caller must preview it. */
export function cardMaterial({ name, role, origin, person, events, choices, userName }) {
    const selected = events.flatMap(event => {
        const choice = choices[event.id] ?? { selected: true, mode: 'placeholder' };
        if (!choice.selected) return [];
        let text = choice.text ?? event.text;
        if (choice.mode === 'omit') {
            // Explicitly drop clauses about User, never claim name substitution removes a relationship.
            const aliases = [...userAliases(userName)];
            text = text.split(/(?<=[。！？；\n])/u).filter(s => !aliases.some(a => s.includes(a))).join('');
        } else if (choice.mode === 'abstract') {
            if (!choice.abstractText) throw new Error('请先生成或填写抽象总结，再导出');
            text = choice.abstractText;
        } else text = replaceUser(text, userName);
        if (!text.trim()) return [];
        return [{ id: event.id, text, mode: choice.mode }];
    });
    return { format: 'ihf-card-material', version: 1, character: { name, role,
        origin: replaceUser(origin, userName),
        personality: replaceUser(person?.arcs?.at(-1)?.to ?? origin, userName) }, events: selected };
}
