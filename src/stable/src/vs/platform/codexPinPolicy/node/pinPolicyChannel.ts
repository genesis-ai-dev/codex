import { activePins, timestampPinDecisions, editPinDecisions, mergePinDecisions, validatePinDecisions } from "../common/pinDecisions.js";
import type { PinDecisions } from "../common/pinDecisions.js";
import { Emitter, Event } from '../../../base/common/event.js';
import { IServerChannel } from '../../../base/parts/ipc/common/ipc.js';
import { promises as fs } from 'fs';
import { PinPolicyArbiter } from '../common/pinPolicyArbiter.js';
import { replaceMetadataPinsInText } from '../common/metadataPinTextEdit.js';

interface Request {
    workspace: string; owner: string; request: number; epoch: number;
    source?: { origin: string; branch: string };
    snapshot?: { origin: string; branch: string; commit: string; pins: PinDecisions };
    filePath?: string;
    edits?: Record<string, { version: string; url: string } | null>;
    ignorePins?: boolean;
    restoreIntent?: boolean;
    pins?: PinDecisions;
}

/** Acceptance and filesystem mutation share a queue: an obsolete write cannot follow a new decision. */
export class PinPolicyChannel implements IServerChannel {
    private readonly arbiter = new PinPolicyArbiter();
    private readonly intents = new Map<string, PinDecisions>();
    private readonly savedSnapshots = new Map<string, string>();
    private readonly snapshots = new Map<string, string>();
    private readonly sources = new Map<string, string>();
    private readonly signatures = new Map<string, string>();
    private readonly queues = new Map<string, Promise<unknown>>();
    private readonly owners = new Map<unknown, Set<string>>();
    private readonly connections = new Map<unknown, number>();
    private readonly changed = new Emitter<{ workspace: string; snapshot?: unknown; intent?: PinDecisions | null; source?: { origin: string; branch: string }; invalidate: boolean }>();
    listen<T>(_context: unknown, event: string): Event<T> {
        if (event !== 'changed') { throw new Error('Unknown pin event'); }
        return this.changed.event as Event<T>;
    }
    disconnect(context: unknown): void {
        this.connections.set(context, (this.connections.get(context) ?? 0) + 1);
        for (const owner of this.owners.get(context) ?? []) { this.arbiter.disconnect(owner); }
        this.owners.delete(context);
    }
    async call<T>(context: unknown, command: string, arg: Request): Promise<T> {
        const connection = this.connections.get(context) ?? 0;
        const previous = this.queues.get(arg.workspace) ?? Promise.resolve();
        const pending = previous.catch(() => {}).then(async () => {
            if (connection !== (this.connections.get(context) ?? 0)) { throw new Error('Pin-policy client disconnected'); }
            return this.execute(context, command, arg);
        });
        this.queues.set(arg.workspace, pending);
        try { return await pending as T; }
        finally { if (this.queues.get(arg.workspace) === pending) { this.queues.delete(arg.workspace); } }
    }
    private async execute(context: unknown, command: string, arg: Request): Promise<unknown> {
        if (arg.snapshot) { arg = { ...arg, snapshot: { ...arg.snapshot, pins: validatePinDecisions(arg.snapshot.pins) } }; }
        switch (command) {
            case 'begin': {
                const source = JSON.stringify([arg.source?.origin, arg.source?.branch]);
                if (arg.source && this.sources.get(arg.workspace) !== source) {
                    this.sources.set(arg.workspace, source);
                    this.snapshots.delete(arg.workspace);
                    this.savedSnapshots.delete(arg.workspace);
                    this.intents.delete(arg.workspace);
                    this.signatures.delete(arg.workspace);
                    this.arbiter.invalidate(arg.workspace);
                    this.changed.fire({ workspace: arg.workspace, source: arg.source, invalidate: true });
                }
                return this.arbiter.begin(arg.workspace);
            }
            case 'accept': {
                const snapshot = arg.snapshot!;
                const signature = JSON.stringify([snapshot.origin, snapshot.branch, activePins(snapshot.pins)]);
                const invalidate = this.signatures.get(arg.workspace) !== signature;
                const accepted = this.arbiter.accept(arg.workspace, arg.request, invalidate);
                if (accepted) {
                    this.snapshots.set(arg.workspace, JSON.stringify(snapshot));
                    this.signatures.set(arg.workspace, signature);
                    this.changed.fire({ workspace: arg.workspace, snapshot, invalidate });
                }
                return accepted;
            }
            case 'isSaved': {
                const current = this.snapshots.get(arg.workspace);
                return !current || (current === JSON.stringify(arg.snapshot) && this.savedSnapshots.get(arg.workspace) === current);
            }
            case 'writePins': {
                const accepted = this.snapshots.get(arg.workspace);
                if (!arg.snapshot || (accepted ? accepted !== JSON.stringify(arg.snapshot) : this.sources.get(arg.workspace) !== JSON.stringify([arg.snapshot.origin, arg.snapshot.branch]))) { throw new Error('Pin decision superseded before metadata write'); }
                if (!arg.filePath || !arg.pins) { throw new Error('Missing metadata write input'); }
                const original = await fs.readFile(arg.filePath, 'utf8');
                const local = arg.ignorePins ? {} : validatePinDecisions(JSON.parse(original.replace(/^\uFEFF/, '')).meta?.pinnedExtensions ?? {});
                const withIntent = this.intents.has(arg.workspace) ? mergePinDecisions(local, this.intents.get(arg.workspace)!) : local;
                const pins = arg.ignorePins ? {} : timestampPinDecisions(mergePinDecisions(withIntent, arg.snapshot!.pins));
                const updated = replaceMetadataPinsInText(original, pins);
                if (updated !== original) { await fs.writeFile(arg.filePath, updated, 'utf8'); }
                this.snapshots.set(arg.workspace, JSON.stringify(arg.snapshot));
                this.savedSnapshots.set(arg.workspace, JSON.stringify(arg.snapshot));
                return;
            }
            case 'setIntent': {
                if (arg.source && this.sources.has(arg.workspace) && this.sources.get(arg.workspace) !== JSON.stringify([arg.source?.origin, arg.source?.branch])) { throw new Error('Repository changed before pin edit'); }
                if (!arg.filePath || (!arg.pins && !arg.edits)) { throw new Error('Missing admin pin input'); }
                const original = await fs.readFile(arg.filePath, 'utf8');
                const local = validatePinDecisions(JSON.parse(original.replace(/^\uFEFF/, '')).meta?.pinnedExtensions ?? {});
                const accepted = this.snapshots.get(arg.workspace);
                const current = accepted ? mergePinDecisions(local, JSON.parse(accepted).pins) : local;
                // Explicit UI edits are stamped here; restoring saved intent never refreshes its clock.
                const edits = arg.edits ?? Object.fromEntries(Array.from(new Set([...Object.keys(current), ...Object.keys(arg.pins ?? {})]))
                    .filter(id => JSON.stringify(activePins(current)[id]) !== JSON.stringify(activePins(arg.pins ?? {})[id]))
                    .map(id => [id, activePins(arg.pins ?? {})[id] ?? null]));
                const pins = arg.restoreIntent ? mergePinDecisions(current, arg.pins!) : editPinDecisions(current, edits);
                const updated = replaceMetadataPinsInText(original, pins);
                if (updated === original && JSON.stringify(this.intents.get(arg.workspace)) === JSON.stringify(pins)) { return; }
                if (updated !== original) { await fs.writeFile(arg.filePath, updated, 'utf8'); }
                this.intents.set(arg.workspace, pins);
                this.changed.fire({ workspace: arg.workspace, intent: pins, invalidate: JSON.stringify(activePins(local)) !== JSON.stringify(activePins(pins)) });
                if (JSON.stringify(activePins(local)) !== JSON.stringify(activePins(pins))) { this.arbiter.invalidate(arg.workspace); }
                return;
            }
            case 'resetIntent': {
                this.intents.delete(arg.workspace);
                this.snapshots.delete(arg.workspace);
                this.savedSnapshots.delete(arg.workspace);
                this.signatures.delete(arg.workspace);
                this.arbiter.invalidate(arg.workspace);
                if (arg.snapshot) {
                    this.sources.set(arg.workspace, JSON.stringify([arg.snapshot.origin, arg.snapshot.branch]));
                    this.snapshots.set(arg.workspace, JSON.stringify(arg.snapshot));
                    this.savedSnapshots.set(arg.workspace, JSON.stringify(arg.snapshot));
                }
                this.changed.fire({ workspace: arg.workspace, snapshot: arg.snapshot, intent: null, invalidate: true });
                return;
            }
            case 'clearIntent': {
                const intent = this.intents.get(arg.workspace);
                const remote = this.snapshots.get(arg.workspace);
                if (intent && (!remote || JSON.stringify(mergePinDecisions(intent, JSON.parse(remote).pins)) !== JSON.stringify(validatePinDecisions(JSON.parse(remote).pins)))) { return false; }
                this.intents.delete(arg.workspace);
                this.changed.fire({ workspace: arg.workspace, intent: null, invalidate: false });
                return true;
            }
            case 'acquire': {
                let owners = this.owners.get(context);
                if (!owners) { owners = new Set(); this.owners.set(context, owners); }
                owners.add(arg.owner);
                return this.arbiter.acquire(arg.workspace, arg.owner);
            }
            case 'valid': return this.arbiter.valid(arg.workspace, arg.owner, arg.epoch);
            case 'release': this.arbiter.release(arg.workspace, arg.owner); return;
            case 'retry': this.arbiter.retry(arg.workspace); this.changed.fire({ workspace: arg.workspace, invalidate: true }); return;
            default: throw new Error('Unknown pin-policy operation');
        }
    }
}
