/** Shared-process arbitration: one transition and one discovery order per workspace. */
export class PinPolicyArbiter {
    private readonly workspaces = new Map<string, { request: number; epoch: number; owner?: string }>();
    private entry(workspace: string) {
        if (!workspace) { throw new Error('Workspace identity required'); }
        let entry = this.workspaces.get(workspace);
        if (!entry) { entry = { request: 0, epoch: 0 }; this.workspaces.set(workspace, entry); }
        return entry;
    }
    invalidate(workspace: string): void { const entry = this.entry(workspace); entry.epoch++; }
    disconnect(owner: string): void {
        for (const entry of this.workspaces.values()) {
            if (entry.owner === owner) { entry.owner = undefined; entry.epoch++; }
        }
    }
    begin(workspace: string): number { return ++this.entry(workspace).request; }
    accept(workspace: string, request: number, changed = true): boolean {
        const entry = this.entry(workspace);
        if (entry.request !== request) { return false; }
        entry.request++; // A ticket can be consumed only once.
        if (changed) { entry.epoch++; }
        return true;
    }
    acquire(workspace: string, owner: string): number | undefined {
        const entry = this.entry(workspace);
        if (entry.owner && entry.owner !== owner) { return undefined; }
        entry.owner = owner;
        return entry.epoch;
    }
    valid(workspace: string, owner: string, epoch: number): boolean {
        const entry = this.entry(workspace);
        return entry.owner === owner && entry.epoch === epoch;
    }
    release(workspace: string, owner: string): void {
        const entry = this.entry(workspace);
        if (entry.owner === owner) { entry.owner = undefined; }
    }
    retry(workspace: string): void { const entry = this.entry(workspace); entry.epoch++; }
}
