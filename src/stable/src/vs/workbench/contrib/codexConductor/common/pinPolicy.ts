/* Pure, persisted pin-policy state. No extension-host or network dependencies. */
export type PinMap = Record<string, { version: string; url: string }>;
export type PinMode = 'ignore' | 'enforce';
export type PinPhase = 'resolving' | 'preparing' | 'switching' | 'ready' | 'blocked';
export interface RemotePinSnapshot { origin: string; branch: string; commit: string; pins: PinMap }
export interface PinRecoveryState {
	mode: PinMode;
	generation: number;
	pins: PinMap;
	phase: PinPhase;
	target?: string;
	error?: string;
	remote?: RemotePinSnapshot;
	localIntent?: PinMap;
	source?: { origin: string; branch: string };
}

/** Reject the whole response rather than interpreting malformed pins as an unpin. */
export function validatePinMap(value: unknown): PinMap {
	if (!value || typeof value !== 'object' || Array.isArray(value)) { throw new Error('Invalid extension pin map'); }
	const result: PinMap = {};
	for (const id of Object.keys(value).sort()) {
		const pin = (value as Record<string, unknown>)[id];
		if (!pin || typeof pin !== 'object' || Array.isArray(pin)) { throw new Error(`Invalid pin: ${id}`); }
		const entry = pin as Record<string, unknown>;
		if (typeof entry.version !== 'string' || !entry.version.trim() || typeof entry.url !== 'string' || !/^https?:\/\//.test(entry.url)) {
			throw new Error(`Invalid pin: ${id}`);
		}
		result[id] = { version: entry.version, url: entry.url };
	}
	return result;
}

export class PinPolicyState {
	readonly state: PinRecoveryState;
	private request = 0;
	private source: { origin: string; branch: string } | undefined;
	constructor(mode: PinMode, saved?: PinRecoveryState) {
		this.state = saved ? JSON.parse(JSON.stringify(saved)) : { mode, generation: 0, pins: {}, phase: 'resolving' };
		this.state.pins = validatePinMap(this.state.pins);
		if (this.state.remote) { this.state.remote.pins = validatePinMap(this.state.remote.pins); }
		if (this.state.mode !== mode) {
			this.state.localIntent = undefined;
			this.state.remote = undefined; // Policy rollback must not resurrect old cached authority.
			this.state.mode = mode;
			this.state.phase = 'resolving';
			this.state.target = undefined;
			this.state.generation++;
		}
	}
	beginRemote(origin: string, branch: string): number {
		const previous = this.state.source ?? this.state.remote;
		this.source = this.state.source = { origin, branch };
		if (!previous || previous.origin !== origin || previous.branch !== branch) {
			this.state.remote = undefined;
			this.state.localIntent = undefined;
			this.retry(); // Fence work immediately, including while the new fetch is offline.
		}
		return ++this.request;
	}
	acceptRemote(request: number, snapshot: RemotePinSnapshot): boolean {
		if (request !== this.request || !this.source || snapshot.origin !== this.source.origin || snapshot.branch !== this.source.branch) { return false; }
		if (!snapshot.commit || !/^[a-f0-9]{40,64}$/i.test(snapshot.commit)) { throw new Error('A verified Git commit is required'); }
		this.state.remote = { ...snapshot, pins: validatePinMap(snapshot.pins) };
		return true;
	}
	select(local: PinMap): number {
		const desired = this.state.mode === 'ignore' ? {} : this.state.localIntent ?? this.state.remote?.pins ?? local;
		const normalized = validatePinMap(desired);
		if (JSON.stringify(normalized) !== JSON.stringify(this.state.pins)) {
			this.state.pins = normalized;
			this.state.generation++;
			this.state.phase = 'resolving';
			this.state.target = undefined;
			this.state.error = undefined;
		}
		return this.state.generation;
	}
	current(generation: number): boolean { return generation === this.state.generation; }
	preparing(generation: number, target: string): boolean {
		if (!this.current(generation) || this.state.phase === 'blocked') { return false; }
		this.state.target = target;
		this.state.phase = 'preparing';
		return true;
	}
	switching(generation: number, target: string): boolean {
		if (!this.current(generation)) { return false; }
		this.state.phase = 'switching';
		this.state.target = target;
		return true;
	}
	ready(generation: number): void {
		if (this.current(generation)) { this.state.phase = 'ready'; this.state.error = undefined; }
	}
	block(generation: number, error: string): void {
		if (this.current(generation)) { this.state.phase = 'blocked'; this.state.error = error; }
	}
	retry(): void {
		this.state.generation++;
		this.state.phase = 'resolving';
		this.state.error = undefined;
		this.state.target = undefined;
	}
}
