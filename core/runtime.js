/** Serialize writes and keep the live memory object stable across asynchronous file requests. */
export function createMemoryWriter({ read, write, merge }) {
    let queue = Promise.resolve();
    return (id, memory, headers) => {
        const task = queue.catch(() => {}).then(async () => {
            const remote = await read(id);
            // Merge after the read: edits made while it was pending are already in memory.
            Object.assign(memory, merge(memory, remote));
            const snapshot = structuredClone(memory);
            snapshot.rev = (memory.rev ?? 0) + 1;
            snapshot.updated = Date.now();
            // The request owns a snapshot; never replace live state when the write returns.
            await write(id, snapshot, headers);
            memory.rev = snapshot.rev;
            memory.updated = snapshot.updated;
        });
        queue = task;
        return task;
    };
}

export function captureGuard(state, signature) {
    const epoch = state.epoch;
    const memory = state.memory;
    const revision = signature();
    return () => {
        if (state.epoch !== epoch || state.memory !== memory || state.config?.enabled === false || signature() !== revision) {
            const error = new Error('聊天或正文已经变化，忽略过期任务结果');
            error.name = 'AbortError';
            throw error;
        }
    };
}
