/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frontier R&D Ltd. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { PinPolicyState, PinRecoveryState, RemotePinSnapshot, validatePinMap } from '../common/pinPolicy.js';
import { IExtensionService } from '../../../services/extensions/common/extensions.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService, WorkbenchState, toWorkspaceIdentifier, isSingleFolderWorkspaceIdentifier } from '../../../../platform/workspace/common/workspace.js';
import { IUserDataProfileService } from '../../../services/userDataProfile/common/userDataProfile.js';
import { IUserDataProfile, IUserDataProfilesService } from '../../../../platform/userDataProfile/common/userDataProfile.js';
import { IWorkbenchExtensionManagementService } from '../../../services/extensionManagement/common/extensionManagement.js';
import { IExtensionGalleryService } from '../../../../platform/extensionManagement/common/extensionManagement.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { URI } from '../../../../base/common/uri.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { parse as parseJsonc } from '../../../../base/common/json.js';
import { applyEdits, setProperty } from '../../../../base/common/jsonEdit.js';
import { FormattingOptions } from '../../../../base/common/jsonFormatter.js';
import { joinPath } from '../../../../base/common/resources.js';
import { IHostService } from '../../../services/host/browser/host.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { timeout } from '../../../../base/common/async.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { PinnedExtensions, RequiredExtensions, ProjectMetadata, parsePinnedExtensions, SideloadEntry, SideloadVsixEntry, parseSideloadEntries } from './codexTypes.js';

/** Maps profile name → array of project folder URIs that reference it. */
type ProfileAssociations = Record<string, string[]>;

const CONDUCTOR_PROFILE_ICON = 'repo-pinned';
const PROFILE_ASSOCIATIONS_KEY = 'codex.conductor.profileAssociations';
const LAST_CLEANUP_KEY = 'codex.conductor.lastCleanup';
const CLEANUP_INTERVAL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

const ADMIN_PINNED_EXTENSIONS_KEY = 'codex.conductor.adminPinnedExtensions';
const REMOTE_PINNED_EXTENSIONS_KEY = 'codex.conductor.remotePinnedExtensions';
const SYNC_COMPLETED_AT_KEY = 'codex.conductor.syncCompletedAt';

/** Strip publisher prefix and common suffixes to get a short profile-friendly name. */
function shortName(extensionId: string): string {
	const afterDot = extensionId.includes('.') ? extensionId.slice(extensionId.indexOf('.') + 1) : extensionId;
	return afterDot.replace(/-extension$/, '');
}

export class CodexConductorContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.codexConductor';

	private metadataUri: URI | undefined;
	private policy!: PinPolicyState;
	private readonly arbiter: IChannel;
	private arbitrationEpoch = 0;
	private activeRecoveryGeneration: number | undefined;
	private remoteCheck: { request: number; origin: string; branch: string } | undefined;
	private finishDiscovery!: () => void;
	private discoveryFinished = false;
	private discoveryError: string | undefined;
	private readonly discovery = new Promise<void>(resolve => { this.finishDiscovery = resolve; });
	private recovery: Promise<void> = Promise.resolve();
	private readonly recoveryKey = 'codex.conductor.pinRecovery.v1';
	private readonly ignorePins: boolean;
	private readonly policySession = `${Date.now()}-${Math.random()}`;

	private readonly syncCompletionListener = this._register(new DisposableStore());

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IUserDataProfileService private readonly userDataProfileService: IUserDataProfileService,
		@IUserDataProfilesService private readonly userDataProfilesService: IUserDataProfilesService,
		@IWorkbenchExtensionManagementService private readonly extensionManagementService: IWorkbenchExtensionManagementService,
		@IExtensionGalleryService private readonly extensionGalleryService: IExtensionGalleryService,
		@IStorageService private readonly storageService: IStorageService,
		@INotificationService private readonly notificationService: INotificationService,
		@IHostService private readonly hostService: IHostService,
		@ILogService private readonly logService: ILogService,
		@ISharedProcessService private readonly sharedProcessService: ISharedProcessService,
		@IProductService private readonly productService: IProductService,
		@IExtensionService private readonly extensionService: IExtensionService,
	) {
		super();
		this.ignorePins = (this.productService as unknown as Record<string, unknown>)['codexProjectPinPolicy'] === 'ignore';
		this.loadPolicy();
		this.arbiter = this.sharedProcessService.getChannel('codexPinPolicy');
		this._register(this.arbiter.listen<{ workspace: string; snapshot?: RemotePinSnapshot; intent?: PinnedExtensions | null; source?: { origin: string; branch: string }; invalidate: boolean }>('changed')(event => this.onPinPolicyEvent(event)));
		if (this.ignorePins) {
			this.storageService.remove(REMOTE_PINNED_EXTENSIONS_KEY, StorageScope.WORKSPACE);
			this.storageService.remove(ADMIN_PINNED_EXTENSIONS_KEY, StorageScope.WORKSPACE);
		}
		this._register(CommandsRegistry.registerCommand('codex.conductor.getPinPolicyStatus', () => this.policyStatus()));
		this._register(CommandsRegistry.registerCommand('codex.conductor.completePinDiscovery', async (_accessor, result: { kind: string; reason?: string }) => {
			this.discoveryError = result.kind === 'invalid' ? result.reason || 'Invalid remote pin policy' : undefined;
			this.discoveryFinished = true;
			this.finishDiscovery();
			// A late result must resume recovery, not leave a timeout or startup-order block behind.
			if (!this.discoveryError && this.policy.state.phase === 'blocked' && this.policy.state.error?.startsWith('Discovery:')) { this.policy.retry(); }
			await this.queueRecovery();
		}));
		this._register(CommandsRegistry.registerCommand('codex.conductor.writeProjectPins', async (_accessor, input: { generation: number }) => {
			const policy = this.policy;
			if (input.generation !== policy.state.generation) { throw new Error('Pin decision superseded'); }
			if (policy.state.localIntent) { return; }
			if (!this.metadataUri || !policy.state.remote) { throw new Error('No accepted project snapshot'); }
			const snapshot = policy.state.remote;
			// The shared process serializes acceptance and the complete read/modify/write,
			// so renderer disconnects and delayed extension-host writes cannot restore old pins.
			await this.arbiter.call('writePins', {
				workspace: this.workspaceContextService.getWorkspace().id,
				filePath: this.metadataUri.fsPath,
				snapshot,
				pins: this.ignorePins ? {} : policy.state.remote.pins
			});
			if (input.generation !== policy.state.generation || policy.state.remote !== snapshot) { return; }
			this.discoveryError = undefined;
			if (this.policy.state.error?.startsWith('Discovery:')) { this.policy.retry(); this.persistPolicy(); }
		}));
		this._register(CommandsRegistry.registerCommand('codex.conductor.stageProjectPinSnapshot', async (_accessor, input: { workspace: string; snapshot: RemotePinSnapshot }) => {
			const workspace = URI.parse(input.workspace);
			if (workspace.scheme !== 'file') { throw new Error('Only local project snapshots can be staged'); }
			const validation = new PinPolicyState('enforce');
			const ticket = validation.beginRemote(input.snapshot.origin, input.snapshot.branch);
			validation.acceptRemote(ticket, { ...input.snapshot, pins: this.ignorePins ? {} : input.snapshot.pins });
			this.storageService.store(`codex.conductor.stagedPins:${workspace.toString()}`, JSON.stringify(validation.state.remote), StorageScope.APPLICATION, StorageTarget.MACHINE);
			await this.storageService.flush();
		}));
		this._register(CommandsRegistry.registerCommand('codex.conductor.reconcilePinPolicy', () => this.queueRecovery().then(() => this.policyStatus())));
		this._register(CommandsRegistry.registerCommand('codex.conductor.retryPinRecovery', async () => {
			if (this.discoveryError) { this.policy.retry(); this.persistPolicy(); await this.storageService.flush(); await this.hostService.reload(); return this.policyStatus(); }
			await this.arbiter.call('retry', { workspace: this.workspaceContextService.getWorkspace().id });
			this.policy.retry();
			await this.queueRecovery();
			if (this.policy.state.phase === 'ready') {
				this.policy.switching(this.policy.state.generation, this.userDataProfileService.currentProfile.name);
				this.persistPolicy();
				await this.hostService.reload(); // Resume extensions whose earlier activation was paused.
			}
			return this.policyStatus();
		}));
		this._register(CommandsRegistry.registerCommand('codex.conductor.beginRemotePinCheck', async (_accessor, source: { origin: string; branch: string }) => {
			this.policy.beginRemote(source.origin, source.branch);
			const request = await this.arbiter.call<number>('begin', { workspace: this.workspaceContextService.getWorkspace().id, source });
			if (this.policy.state.localIntent && this.metadataUri) {
				await this.arbiter.call('setIntent', { workspace: this.workspaceContextService.getWorkspace().id, source, filePath: this.metadataUri.fsPath, pins: this.policy.state.localIntent });
			}
			if (!this.remoteCheck || request > this.remoteCheck.request) { this.remoteCheck = { ...source, request }; }
			return { session: this.policySession, request };
		}));
		this._register(CommandsRegistry.registerCommand('codex.conductor.acceptRemotePinSnapshot', async (_accessor, input: { session: string; request: number; snapshot: RemotePinSnapshot }) => {
			if (input.session !== this.policySession || input.request !== this.remoteCheck?.request
				|| input.snapshot.origin !== this.remoteCheck.origin || input.snapshot.branch !== this.remoteCheck.branch) { return { accepted: false, ...this.policyStatus() }; }
			const snapshot = { ...input.snapshot, pins: this.ignorePins ? {} : validatePinMap(input.snapshot.pins) };
			if (!snapshot.origin || !snapshot.branch || !/^[a-f0-9]{40,64}$/i.test(snapshot.commit)) { throw new Error('Invalid remote snapshot'); }
			if (!await this.arbiter.call<boolean>('accept', { workspace: this.workspaceContextService.getWorkspace().id, request: input.request, snapshot })) { return { accepted: false, ...this.policyStatus() }; }
			// Ordered shared-process events own the local mirror. Do not replay an older
			// acknowledgement over a newer event delivered while this request awaited IPC.
			if (input.request !== this.remoteCheck?.request || JSON.stringify(this.policy.state.remote) !== JSON.stringify(snapshot)) {
				return { accepted: false, ...this.policyStatus() };
			}
			// Caller persists metadata before requesting reconciliation; no reload inside acceptance.
			return { accepted: true, ...this.policyStatus() };
		}));

		this._register(CommandsRegistry.registerCommand('codex.conductor.cleanupProfiles', () => this.runProfileCleanup()));
		this._register(CommandsRegistry.registerCommand('codex.conductor.getEffectivePinnedExtensions', () => this.readEffectivePinsInternal()));

		this._register(CommandsRegistry.registerCommand('codex.conductor.setAdminPinIntent', async (_accessor, pins: PinnedExtensions) => {
			if (this.ignorePins) { return; }
			if (!this.metadataUri) { throw new Error('No project metadata'); }
			const intent = validatePinMap(pins);
			await this.arbiter.call('setIntent', { workspace: this.workspaceContextService.getWorkspace().id, source: this.policy.state.source, filePath: this.metadataUri.fsPath, pins: intent });
			this.persistPolicy();
			this.storageService.store(ADMIN_PINNED_EXTENSIONS_KEY, JSON.stringify(this.policy.state.localIntent ?? {}), StorageScope.WORKSPACE, StorageTarget.MACHINE);
		}));
		this._register(CommandsRegistry.registerCommand('codex.conductor.clearAdminPinIntent', async () => {
			if (this.policy.state.localIntent && JSON.stringify(this.policy.state.localIntent) !== JSON.stringify(this.policy.state.remote?.pins)) { return; }
			if (!await this.arbiter.call<boolean>('clearIntent', { workspace: this.workspaceContextService.getWorkspace().id })) { return; }
			this.persistPolicy();
			this.storageService.remove(ADMIN_PINNED_EXTENSIONS_KEY, StorageScope.WORKSPACE);
		}));

		this._register(CommandsRegistry.registerCommand('codex.conductor.hasAdminPinIntent', () => {
			return !!this.policy.state.localIntent;
		}));

		this._register(CommandsRegistry.registerCommand('codex.conductor.setRemotePins', (_accessor, pins: PinnedExtensions | null | undefined) => {
			if (this.ignorePins || this.policy.state.remote) { return; }
			if (pins && Object.keys(pins).length > 0) {
				this.storageService.store(REMOTE_PINNED_EXTENSIONS_KEY, JSON.stringify(pins), StorageScope.WORKSPACE, StorageTarget.MACHINE);
			} else {
				this.storageService.remove(REMOTE_PINNED_EXTENSIONS_KEY, StorageScope.WORKSPACE);
			}
		}));

		this._register(CommandsRegistry.registerCommand('codex.conductor.getPinMismatches', async () => {
			const pins = await this.readEffectivePinsInternal();
			if (!pins) { return []; }

			const installed = await this.extensionManagementService.getInstalled();
			const mismatches: { extensionId: string; pinnedVersion: string; runningVersion: string | null }[] = [];
			for (const [id, pin] of Object.entries(pins)) {
				const ext = installed.find(e => e.identifier.id.toLowerCase() === id.toLowerCase());
				if (!ext || ext.manifest.version !== pin.version) {
					mismatches.push({ extensionId: id, pinnedVersion: pin.version, runningVersion: ext?.manifest.version || null });
				}
			}
			return mismatches;
		}));

		this._register(CommandsRegistry.registerCommand('codex.conductor.setSyncCompletedAt', (_accessor, timestamp: number) => {
			this.storageService.store(SYNC_COMPLETED_AT_KEY, timestamp, StorageScope.WORKSPACE, StorageTarget.MACHINE);
		}));

		this._register(this.workspaceContextService.onDidChangeWorkbenchState(() => void this.initialize()));

		void this.initialize();
	}

	private onPinPolicyEvent(event: { workspace: string; snapshot?: RemotePinSnapshot; intent?: PinnedExtensions | null; source?: { origin: string; branch: string }; invalidate: boolean }): void {
		if (event.workspace !== this.workspaceContextService.getWorkspace().id) { return; }
		if (event.invalidate) {
			this.arbitrationEpoch++;
			if (this.policy.state.phase === 'preparing' && this.activeRecoveryGeneration === this.policy.state.generation) { this.policy.retry(); }
		}
		if (event.intent !== undefined) { this.policy.state.localIntent = event.intent ?? undefined; this.policy.select(this.policy.state.pins); this.persistPolicy(); }
		if (event.source) { this.policy.beginRemote(event.source.origin, event.source.branch); }
		if (event.snapshot) {
			this.policy.acceptRemote(this.policy.beginRemote(event.snapshot.origin, event.snapshot.branch), event.snapshot);
			this.policy.select({});
			this.persistPolicy();
		}
	}


	private getCoreExtensionEntries(): SideloadEntry[] {
		const configured = (this.productService as unknown as Record<string, unknown>)['codexSideloadExtensions'];
		if (!Array.isArray(configured)) {
			return [];
		}
		return parseSideloadEntries(configured);
	}

	private loadPolicy(): void {
		try {
			const saved = JSON.parse(this.storageService.get(this.recoveryKey, StorageScope.WORKSPACE, 'null')) as PinRecoveryState | undefined;
			this.policy = new PinPolicyState(this.ignorePins ? 'ignore' : 'enforce', saved || undefined);
		} catch {
			this.policy = new PinPolicyState(this.ignorePins ? 'ignore' : 'enforce');
		}
	}

	private persistPolicy(): void {
		this.storageService.store(this.recoveryKey, JSON.stringify(this.policy.state), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}

	private policyStatus() {
		return { protocolVersion: 1, ...this.policy.state, pendingIntent: !!this.policy.state.localIntent, workspace: this.workspaceContextService.getWorkspace().folders[0]?.uri.toString() };
	}

	private async initialize(): Promise<void> {
		this.metadataUri = this.workspaceContextService.getWorkbenchState() === WorkbenchState.FOLDER
			? joinPath(this.workspaceContextService.getWorkspace().folders[0].uri, 'metadata.json') : undefined;
		const workspace = this.workspaceContextService.getWorkspace().folders[0]?.uri;
		if (workspace) {
			const key = `codex.conductor.stagedPins:${workspace.toString()}`;
			const staged = this.storageService.get(key, StorageScope.APPLICATION);
			if (staged) {
				try {
					const snapshot = JSON.parse(staged) as RemotePinSnapshot;
					// Project Update intentionally replaces local policy, including unpublished intent.
					this.policy.state.localIntent = undefined;
					this.storageService.remove(ADMIN_PINNED_EXTENSIONS_KEY, StorageScope.WORKSPACE);
					await this.arbiter.call('resetIntent', { workspace: this.workspaceContextService.getWorkspace().id, snapshot });
					this.policy.acceptRemote(this.policy.beginRemote(snapshot.origin, snapshot.branch), snapshot);
					this.policy.select({});
					this.persistPolicy();
					this.storageService.remove(key, StorageScope.APPLICATION);
				} catch (error) {
					this.policy.block(this.policy.state.generation, `Invalid staged project snapshot: ${String(error)}`);
				}
			}
		}
		this.syncCompletionListener.clear();
		this.syncCompletionListener.add(this.storageService.onDidChangeValue(StorageScope.WORKSPACE, undefined, this.syncCompletionListener)(event => {
			if ([REMOTE_PINNED_EXTENSIONS_KEY, ADMIN_PINNED_EXTENSIONS_KEY, SYNC_COMPLETED_AT_KEY].includes(event.key)) {
				void this.queueRecovery();
			}
		}));
		await this.queueRecovery();
		if (this.policy.state.phase === 'ready') { await this.maybeCleanupOrphanedProfiles(); }
		await this.logStartupExtensionState();
	}

	private async awaitDiscovery(): Promise<void> {
		if (this.ignorePins || !this.metadataUri || !await this.fileService.exists(this.metadataUri)) { return; }
		if (this.discoveryError) { throw new Error(this.discoveryError); }
		if (this.discoveryFinished) { return; }
		await Promise.race([this.discovery, timeout(20000)]);
		if (this.discoveryError) { throw new Error(this.discoveryError); }
		if (!this.discoveryFinished) {
			this.logService.warn('[CodexConductor] Discovery unavailable; using accepted/local pins until Frontier is ready');
			this.discoveryFinished = true;
		}
	}

	private queueRecovery(): Promise<void> {
		// Refresh the decision immediately, even while an older installation is awaiting I/O.
		const selection = this.awaitDiscovery().then(() => this.readEffectivePinsInternal()).then(pins => {
			this.policy.select(pins || {});
			this.persistPolicy();
		});
		// Selection can fail while a previous recovery is still awaiting package I/O.
		void selection.catch(() => {});
		this.recovery = this.recovery.catch(() => {}).then(async () => {
			await selection;
			const workspace = this.workspaceContextService.getWorkspace().id;
			if (this.policy.state.error?.startsWith('Coordination:')) { this.policy.retry(); }
			const lease = await this.arbiter.call<number | undefined>('acquire', { workspace, owner: this.policySession });
			if (lease === undefined) {
				this.policy.block(this.policy.state.generation, 'Coordination: Another window is recovering this project. Wait for it to finish, then retry recovery.');
				this.persistPolicy();
				return;
			}
			this.activeRecoveryGeneration = this.policy.state.generation;
			try { await this.reconcilePolicy(lease); }
			finally { this.activeRecoveryGeneration = undefined; await this.arbiter.call('release', { workspace, owner: this.policySession }); }
		}).catch(error => {
			this.policy.block(this.policy.state.generation, this.discoveryError ? `Discovery: ${String(error)}` : String(error));
			this.persistPolicy();
			this.logService.error('[CodexConductor] Pin recovery blocked', error);
		});
		return this.recovery;
	}

	private async reconcilePolicy(lease?: number): Promise<void> {
		const policy = this.policy;
		const generation = policy.state.generation;
		const epoch = this.arbitrationEpoch;
		const current = () => this.policy === policy && policy.current(generation) && epoch === this.arbitrationEpoch;
		const pins = policy.state.pins;
		const hasPins = Object.keys(pins).length > 0;
		if (policy.state.remote && !policy.state.localIntent) {
			const saved = await this.arbiter.call<boolean>('isSaved', { workspace: this.workspaceContextService.getWorkspace().id, snapshot: policy.state.remote });
			if (!current()) { return; }
			if (!saved) {
				policy.block(generation, 'Discovery: Accepted pins must be saved before profile recovery');
				this.persistPolicy();
				return;
			}
			if (!this.discoveryError && policy.state.error?.startsWith('Discovery:')) {
				policy.state.phase = 'resolving';
				policy.state.error = undefined;
			}
		}
		const active = this.userDataProfileService.currentProfile;
		const normal = active.icon === CONDUCTOR_PROFILE_ICON ? this.userDataProfilesService.defaultProfile : active;
		const targetName = hasPins ? this.resolveProfileName(pins) : normal.name;
		let target = hasPins ? this.userDataProfilesService.profiles.find(p => p.name === targetName) : normal;
		const complete = target && await this.validateProfileExtensions(target, pins);
		if (!current()) { return; }
		await this.extensionService.whenInstalledExtensionsRegistered();
		const selected = target ? await this.extensionManagementService.getInstalled(undefined, target.extensionsResource) : [];
		if (!current()) { return; }
		const runningCore = this.getCoreExtensionEntries().every(entry => {
			const id = typeof entry === 'string' ? entry : entry.id;
			const expected = selected.find(ext => ext.identifier.id.toLowerCase() === id.toLowerCase());
			return !!expected && this.extensionService.extensions.some(ext => ext.identifier.value.toLowerCase() === id.toLowerCase() && ext.version === expected.manifest.version
				&& (!this.ignorePins || !['project-accelerate.codex-editor-extension', 'frontier-rnd.frontier-authentication'].includes(id.toLowerCase())
					|| (ext as unknown as { codexProjectPinPolicyVersion?: number }).codexProjectPinPolicyVersion === 2));
		});
		const runningMatches = runningCore && target?.id === this.userDataProfileService.currentProfile.id && complete
			&& Object.entries(pins).every(([id, pin]) => this.extensionService.extensions.some(ext => ext.identifier.value.toLowerCase() === id.toLowerCase() && ext.version === pin.version));
		if (runningMatches) {
			if (!hasPins) { this.removeCurrentProjectFromAssociations(); }
			policy.ready(generation);
			this.persistPolicy();
			return;
		}
		if (policy.state.phase === 'blocked') { return; }
		// A previous host already attempted this exact transition. Never reload indefinitely.
		if (policy.state.phase === 'switching' || policy.state.phase === 'preparing') {
			policy.block(generation, 'Previous profile transition did not complete. Check extension packages, then run Retry Pin Recovery.');
			this.persistPolicy();
			return;
		}
		if (hasPins && this.metadataUri) { this.addProfileAssociation(targetName, this.workspaceContextService.getWorkspace().folders[0].uri.toString()); }
		policy.preparing(generation, targetName);
		this.persistPolicy();
		try {
			if (!target) { target = await this.userDataProfilesService.createNamedProfile(targetName, { icon: CONDUCTOR_PROFILE_ICON }); }
			if (!current()) { return; }
			if (!complete) {
				await this.installPinnedExtensions(pins, target, current);
				if (!current()) { return; }
				await this.backfillCoreExtensions(target, new Set(Object.keys(pins).map(id => id.toLowerCase())), current);
			}
			if (!current()) { return; }
			if (!await this.validateProfileExtensions(target, pins)) { throw new Error('Target profile is incomplete or lacks compatible Editor/Frontier packages. Install the coordinated builds and retry.'); }
			if (!current()) { return; }
			if (lease !== undefined && !await this.arbiter.call<boolean>('valid', { workspace: this.workspaceContextService.getWorkspace().id, owner: this.policySession, epoch: lease })) { return; }
			if (!current()) { return; }
			policy.switching(generation, target.name);
			this.persistPolicy();
			await this.storageService.flush();
			if (!current()) { return; }
			await this.switchProfileAndReload(target, true, current);
		} catch (error) {
			if (!current()) { return; }
			policy.block(generation, String(error));
			this.persistPolicy();
			this.notificationService.warn(`Project extension recovery paused: ${String(error)}. Retry after packages or connectivity are available.`);
		}
	}

	private async installPinnedExtensions(pins: PinnedExtensions, profile: IUserDataProfile, current: () => boolean = () => true): Promise<void> {
		// Use the shared process 'extensions' IPC channel directly to bypass
		// NativeExtensionManagementService.downloadVsix(), which downloads in the
		// renderer using browser fetch() — that fails for GitHub release URLs due
		// to CORS on the 302 redirect. The shared process downloads via Node.js
		// networking which handles redirects without CORS restrictions.
		const channel = this.sharedProcessService.getChannel('extensions');

		// Inspect current state of the profile to avoid redundant/failing reinstalls
		const installed = await this.extensionManagementService.getInstalled(undefined, profile.extensionsResource);

		for (const [id, pin] of Object.entries(pins)) {
			if (!current()) { return; }
			const existing = installed.find(e => e.identifier.id.toLowerCase() === id.toLowerCase());
			if (existing && existing.manifest.version === pin.version) {
				this.logService.info(`[CodexConductor] Pinned extension "${id}" v${pin.version} already installed in profile "${profile.name}" — skipping VSIX download`);
				continue;
			}

			let lastError: Error | undefined;
			for (let attempt = 1; attempt <= 3; attempt++) {
				if (!current()) { return; }
				try {
					this.logService.info(`[CodexConductor] Installing pinned VSIX for "${id}" v${pin.version} from ${pin.url} (attempt ${attempt}/3)`);

					// `isApplicationScoped: false` is explicit (not omitted)
					// because the upstream install task inherits this flag from
					// any existing installation of the same extension — see the
					// patched line at extensionManagementService.ts:1047 (`??`
					// semantics). If a sideloaded copy in the Default profile
					// were marked app-scoped, the conductor's pin would inherit
					// that flag, get filtered out of its own profile by the
					// scanner, and post-install verification would fail with
					// "Cannot read the extension from …". Forcing `false` keeps
					// the pin scoped to its conductor profile.
					await channel.call('install', [URI.parse(pin.url), {
						installGivenVersion: true,
						pinned: true,
						isApplicationScoped: false,
						profileLocation: profile.extensionsResource
					}]);
					lastError = undefined;
					break; // Success
				} catch (e: unknown) {
					lastError = e instanceof Error ? e : new Error(String(e));
					(lastError as any).extensionId = id;
					(lastError as any).url = pin.url;
					const code = (lastError as any).code ? ` [Code: ${(lastError as any).code}]` : '';
					const stack = lastError.stack ? `\nStack: ${lastError.stack}` : '';
					this.logService.error(`[CodexConductor] Failed to install pinned extension ${id} from ${pin.url} (attempt ${attempt}/3) [Online: ${navigator.onLine}]: ${lastError.message}${code}${stack}`);
					console.error(`[CodexConductor] Installation error for ${id} (attempt ${attempt}/3):`, lastError);

					if (attempt < 3) {
						const delay = Math.pow(2, attempt) * 1000;
						await timeout(delay);
					}
				}
			}

			if (lastError) {
				throw lastError;
			}
		}
	}

	private async logStartupExtensionState(): Promise<void> {
		const installed = await this.extensionManagementService.getInstalled();
		const coreVersions = this.getCoreExtensionEntries().map(entry => {
			const id = typeof entry === 'string' ? entry : entry.id;
			const version = installed.find(e => e.identifier.id.toLowerCase() === id.toLowerCase())?.manifest.version ?? 'not installed';
			return `${id}=${version}`;
		}).join(', ');

		const currentProfileName = this.userDataProfileService.currentProfile.name;
		const requiredExtensions = await this.readRequiredExtensionsFromMetadata();
		const pinnedExtensions = await this.readEffectivePinnedExtensions();

		this.logService.info(
			`[CodexConductor] Startup extension state — profile=${currentProfileName}, ${coreVersions}, pinnedExtensions=${this.formatObjectForLog(pinnedExtensions)}, requiredExtensions=${this.formatObjectForLog(requiredExtensions)}`
		);
	}

	/**
	 * Reads project metadata from metadata.json on disk.
	 */
	private async readProjectMetadata(): Promise<ProjectMetadata | undefined> {
		if (!this.metadataUri) {
			return undefined;
		}

		try {
			const content = await this.fileService.readFile(this.metadataUri);
			try {
				return JSON.parse(content.value.toString()) as ProjectMetadata;
			} catch (parseError) {
				this.logService.warn('[CodexConductor] metadata.json contains invalid JSON — extension pinning disabled');
				return undefined;
			}
		} catch {
			return undefined;
		}
	}

	/**
	 * Reads the effective pinned extensions by considering:
	 * Release policy overrides pins. Verified, source-bound remote snapshots take
	 * precedence over local state; legacy remote caches are not authoritative.
	 */
	private async readEffectivePinsInternal(): Promise<PinnedExtensions | undefined> {
		if (this.ignorePins) { return {}; }
		if (this.policy.state.localIntent) { return this.policy.state.localIntent; }
		if (this.policy.state.remote) { return this.policy.state.remote.pins; }
		// Legacy cache lacks repository/branch provenance and cannot establish authority.
		// 3. Fall back to metadata.json on disk
		if (!this.metadataUri) { return {}; }
		let content;
		try { content = await this.fileService.readFile(this.metadataUri); }
		catch (error) { if (!await this.fileService.exists(this.metadataUri)) { return {}; } throw error; }
		const metadata = JSON.parse(content.value.toString()) as ProjectMetadata;
		return validatePinMap(metadata.meta?.pinnedExtensions === undefined ? {} : metadata.meta.pinnedExtensions);
	}

	private async readRequiredExtensionsFromMetadata(): Promise<RequiredExtensions> {
		const metadata = await this.readProjectMetadata();
		return metadata?.meta?.requiredExtensions || {};
	}

	private async readEffectivePinnedExtensions(): Promise<PinnedExtensions> {
		return (await this.readEffectivePinsInternal()) || {};
	}

	private formatObjectForLog<T extends object>(value: T): string {
		const sortedEntries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
		return JSON.stringify(Object.fromEntries(sortedEntries));
	}

	// ── Profile lifecycle cleanup ──────────────────────────────────────

	/**
	 * Runs cleanup if at least CLEANUP_INTERVAL_MS has passed since the last run.
	 */
	private async maybeCleanupOrphanedProfiles(): Promise<void> {
		const lastCleanup = this.storageService.getNumber(LAST_CLEANUP_KEY, StorageScope.APPLICATION, 0);
		if (Date.now() - lastCleanup < CLEANUP_INTERVAL_MS) {
			return;
		}
		await this.runProfileCleanup();
	}

	/**
	 * Cleans up conductor-managed profiles that are no longer referenced by any
	 * project on disk. Can be called directly via the
	 * `codex.conductor.cleanupProfiles` command for testing.
	 *
	 * For each conductor profile, checks every associated project path:
	 * - If the project's metadata.json is unreadable (deleted, moved), remove
	 *   the association.
	 * - If the project's pins no longer resolve to this profile name, remove
	 *   the association.
	 * - If no associations remain, delete the profile.
	 */
	async runProfileCleanup(): Promise<void> {
		const associations = this.getProfileAssociations();
		const conductorProfiles = this.userDataProfilesService.profiles.filter(
			p => !p.isDefault && p.icon === CONDUCTOR_PROFILE_ICON
		);

		if (conductorProfiles.length === 0) {
			this.storageService.store(LAST_CLEANUP_KEY, Date.now(), StorageScope.APPLICATION, StorageTarget.MACHINE);
			return;
		}

		let removedCount = 0;

		for (const profile of conductorProfiles) {
			// Don't remove the profile we're currently using
			if (profile.id === this.userDataProfileService.currentProfile.id) {
				continue;
			}

			const projectPaths = associations[profile.name] || [];
			const stillReferenced = await this.isProfileReferencedByAnyProject(profile.name, projectPaths);

			if (!stillReferenced) {
				try {
					await this.userDataProfilesService.removeProfile(profile);
					delete associations[profile.name];
					removedCount++;
				} catch {
					// Profile may be in use by another window — skip silently
				}
			}
		}

		this.storeProfileAssociations(associations);
		this.storageService.store(LAST_CLEANUP_KEY, Date.now(), StorageScope.APPLICATION, StorageTarget.MACHINE);

		this.logService.info(`[CodexConductor] Profile cleanup complete — removed ${removedCount} orphaned profile${removedCount !== 1 ? 's' : ''}, ${conductorProfiles.length - removedCount} retained`);
	}

	/**
	 * Checks if any of the given project paths still have pins that resolve
	 * to the given profile name.
	 */
	private async isProfileReferencedByAnyProject(profileName: string, projectPaths: string[]): Promise<boolean> {
		for (const projectPath of projectPaths) {
			try {
				const metadataUri = joinPath(URI.parse(projectPath), 'metadata.json');
				const content = await this.fileService.readFile(metadataUri);
				const metadata = JSON.parse(content.value.toString());
				const pins = parsePinnedExtensions(metadata?.meta?.pinnedExtensions);

				if (pins && this.resolveProfileName(pins) === profileName) {
					return true;
				}
			} catch {
				// Project unreadable (deleted, moved) — not referencing
			}
		}
		return false;
	}

	// ── Profile association tracking ───────────────────────────────────

	private getProfileAssociations(): ProfileAssociations {
		const raw = this.storageService.get(PROFILE_ASSOCIATIONS_KEY, StorageScope.APPLICATION);
		if (!raw) { return {}; }
		try {
			return JSON.parse(raw);
		} catch {
			return {};
		}
	}

	private storeProfileAssociations(associations: ProfileAssociations): void {
		this.storageService.store(PROFILE_ASSOCIATIONS_KEY, JSON.stringify(associations), StorageScope.APPLICATION, StorageTarget.MACHINE);
	}

	private addProfileAssociation(profileName: string, projectUri: string): void {
		const associations = this.getProfileAssociations();
		const paths = associations[profileName] || [];
		if (!paths.includes(projectUri)) {
			paths.push(projectUri);
		}
		associations[profileName] = paths;
		this.storeProfileAssociations(associations);
	}

	private removeCurrentProjectFromAssociations(): void {
		const workspaceFolder = this.workspaceContextService.getWorkspace().folders[0];
		if (!workspaceFolder) { return; }

		const projectUri = workspaceFolder.uri.toString();
		const associations = this.getProfileAssociations();
		let changed = false;

		for (const profileName of Object.keys(associations)) {
			const paths = associations[profileName];
			const idx = paths.indexOf(projectUri);
			if (idx !== -1) {
				paths.splice(idx, 1);
				changed = true;
				if (paths.length === 0) {
					delete associations[profileName];
				}
			}
		}

		if (changed) {
			this.storeProfileAssociations(associations);
		}
	}

	// ── Utilities ──────────────────────────────────────────────────────

	/**
	 * Validates that all pinned extensions are actually installed in the given
	 * profile. Uses `getInstalled(type, profileLocation)` to inspect a profile's
	 * extensions without switching to it. Returns false if any pinned extension
	 * is missing or at the wrong version (e.g. interrupted install left an
	 * incomplete profile).
	 */
	private async validateProfileExtensions(profile: IUserDataProfile, pins: PinnedExtensions): Promise<boolean> {
		try {
			const installed = await this.extensionManagementService.getInstalled(undefined, profile.extensionsResource);
			if (this.ignorePins && ['project-accelerate.codex-editor-extension', 'frontier-rnd.frontier-authentication'].some(id => !installed.some(ext => ext.identifier.id.toLowerCase() === id && (ext.manifest as unknown as Record<string, unknown>).codexProjectPinPolicyVersion === 2))) { return false; }
			for (const [id, pin] of Object.entries(pins)) {
				const ext = installed.find(e => e.identifier.id.toLowerCase() === id.toLowerCase());
				if (!ext || ext.manifest.version !== pin.version) {
					return false;
				}
			}

			// Core suite must be present even if unpinned
			const pinnedLower = new Set(Object.keys(pins).map(id => id.toLowerCase()));
			for (const entry of this.getCoreExtensionEntries()) {
				const id = typeof entry === 'string' ? entry : entry.id;
				if (pinnedLower.has(id.toLowerCase())) {
					continue;
				}
				const installedExt = installed.find(e => e.identifier.id.toLowerCase() === id.toLowerCase());
				if (!installedExt) {
					return false;
				}
				if (typeof entry !== 'string' && installedExt.manifest.version !== entry.version) {
					return false;
				}
			}

			return true;
		} catch {
			return false;
		}
	}

	private resolveProfileName(pins: PinnedExtensions): string {
		const ids = Object.keys(pins).sort();
		const firstId = ids[0];
		const base = `${shortName(firstId)}-v${pins[firstId].version}`;
		if (ids.length === 1) { return base; }

		// Simple hash of all id@version pairs for deterministic multi-pin names
		let h = 5381;
		const str = ids.map(id => `${id}@${pins[id].version}`).join(',');
		for (let i = 0; i < str.length; i++) { h = (((h << 5) + h) ^ str.charCodeAt(i)) >>> 0; }
		return `${base}+${h.toString(16).slice(0, 4)}`;
	}

	/**
	 * Seeds a conductor-managed profile's settings.json with the keys needed to
	 * keep pinned extensions stable: disables the marketplace update check and
	 * auto-update for that profile only. Idempotent — skips the write when the
	 * desired values are already present. Requires the companion patch that
	 * drops APPLICATION scope from `extensions.autoCheckUpdates` /
	 * `extensions.autoUpdate` so that profile settings can override the
	 * user-level defaults.
	 *
	 * Uses jsonEdit.setProperty + applyEdits instead of a full parse/rewrite
	 * so any user-authored content in the file (comments, trailing commas,
	 * unrelated keys, custom formatting) is preserved byte-for-byte.
	 */
	private async seedProfileSettings(profile: IUserDataProfile): Promise<void> {
		if (profile.icon !== CONDUCTOR_PROFILE_ICON) {
			return;
		}

		const uri = profile.settingsResource;
		let original = '';
		try {
			const buf = await this.fileService.readFile(uri);
			original = buf.value.toString();
		} catch {
			// No file yet — writeFile below will create it.
		}

		// parseJsonc tolerates JSONC. If it returns anything other than a
		// plain object (malformed / array / scalar), fall back to an empty
		// document so applyEdits has a valid structure to work on.
		const parsed: unknown = original.trim() ? parseJsonc(original, []) : undefined;
		const asObject = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
			? parsed as Record<string, unknown>
			: undefined;

		if (
			asObject
			&& asObject['extensions.autoCheckUpdates'] === false
			&& asObject['extensions.autoUpdate'] === false
		) {
			return;
		}

		let text = asObject ? original : '{}';
		const formattingOptions: FormattingOptions = { tabSize: 4, insertSpaces: true, eol: '\n' };
		for (const [key, value] of [
			['extensions.autoCheckUpdates', false],
			['extensions.autoUpdate', false],
		] as const) {
			text = applyEdits(text, setProperty(text, [key], value, formattingOptions));
		}

		try {
			await this.fileService.writeFile(uri, VSBuffer.fromString(text));
			this.logService.info(`[CodexConductor] Seeded profile "${profile.name}" settings — update checks disabled`);
		} catch (e: unknown) {
			this.logService.warn(`[CodexConductor] Failed to seed profile settings for "${profile.name}": ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	/**
	 * switchProfile() for folder workspaces only persists the profile association
	 * (via setProfileForWorkspace) — it does NOT restart the extension host or
	 * change the active profile in the current session. A window reload is needed
	 * to make the switch effective. If the extension host restart is vetoed (e.g.
	 * a custom editor like Startup Flow is open), switchProfile() throws
	 * CancellationError and reverts the association — reload handles that too.
	 *
	 * Pass `forceReload = true` when extensions were installed/updated in the
	 * target profile during this call, even if the user is already on it. Without
	 * a reload, freshly installed extensions whose activation events have already
	 * passed (e.g. `onStartupFinished`) won't activate until the next manual
	 * reload, leaving the profile silently degraded.
	 */
	private async switchProfileAndReload(profile: IUserDataProfile, forceReload = false, current: () => boolean = () => true): Promise<void> {
		if (!current()) { return; }
		const workspace = this.workspaceContextService.getWorkspace();
		const workspaceIdentifier = toWorkspaceIdentifier(workspace);
		const originalProfileId = this.userDataProfileService.currentProfile.id;
		const currentProfileName = this.userDataProfileService.currentProfile.name;

		this.logService.info(`[CodexConductor] switchProfileAndReload: current=${currentProfileName}, target=${profile.name}, forceReload=${forceReload}`);

		// Ensure the target conductor profile has update-checks disabled before
		// the reload commits. Harmless (no-op) for the default profile.
		await this.seedProfileSettings(profile);
		this.logService.info(`[CodexConductor] Workspace ID: ${workspaceIdentifier.id}`);
		if (isSingleFolderWorkspaceIdentifier(workspaceIdentifier)) {
			this.logService.info(`[CodexConductor] Workspace URI: ${workspaceIdentifier.uri.toString()}`);
		}

		// Explicitly set the association for the workspace.
		// For folder workspaces, this is the primary way VS Code associates a profile.
		// updateProfile() cascades — assigning the workspace to this profile implicitly
		// removes it from any other profile that still claims it, so no pre-cleanup is
		// required. (Previously called resetWorkspaces() here, but that wiped every
		// open project's associations globally.)
		this.logService.info(`[CodexConductor] Calling setProfileForWorkspace...`);
		if (!current()) { return; }
		await this.userDataProfilesService.setProfileForWorkspace(workspaceIdentifier, profile);
		this.logService.info(`[CodexConductor] setProfileForWorkspace completed`);

		// Compare against the profile ID captured BEFORE setProfileForWorkspace.
		// setProfileForWorkspace may internally trigger changeCurrentProfile which
		// updates currentProfile even if the extension host vetos the switch. Using
		// the post-call currentProfile.id would incorrectly skip the reload.
		if (!current()) { return; }
		if (forceReload || originalProfileId !== profile.id) {
			const reason = originalProfileId !== profile.id
				? `profile mismatch (${currentProfileName} != ${profile.name})`
				: `extensions installed in current profile`;
			this.logService.info(`[CodexConductor] ${reason} — triggering authoritative reload`);
			await this.arbiter.call('release', { workspace: workspace.id, owner: this.policySession });
			await this.hostService.reload({ forceProfile: profile.name });
		} else {
			this.logService.info(`[CodexConductor] Already on target profile ${profile.name} — no reload needed`);
		}
	}

	/**
	 * Installs core (sideload) extensions into a conductor-managed profile.
	 *
	 * Fail-fast by design: the sideloader's best-effort behaviour (warn + skip on
	 * any failure) is wrong here because the resulting profile would be silently
	 * incomplete, and the user couldn't sync, edit, or otherwise function. By
	 * throwing, we let recovery persist a blocked state. Explicit retry reuses the
	 * partial profile and verifies it before switching.
	 */
	private async backfillCoreExtensions(profile: IUserDataProfile, pinnedIds: Set<string>, current: () => boolean = () => true): Promise<void> {
		const installed = await this.extensionManagementService.getInstalled(undefined, profile.extensionsResource);
		const coreEntries = this.getCoreExtensionEntries();

		const missingGallery: string[] = [];
		const missingVsix: SideloadVsixEntry[] = [];

		for (const entry of coreEntries) {
			const id = typeof entry === 'string' ? entry : entry.id;
			if (pinnedIds.has(id.toLowerCase())) {
				continue;
			}

			const installedExt = installed.find(e => e.identifier.id.toLowerCase() === id.toLowerCase());
			if (typeof entry === 'string') {
				if (!installedExt) {
					missingGallery.push(entry);
				}
			} else {
				if (!installedExt || installedExt.manifest.version !== entry.version) {
					missingVsix.push(entry);
				}
			}
		}

		if (missingGallery.length === 0 && missingVsix.length === 0) {
			return;
		}

		this.logService.info(`[CodexConductor] Backfilling core extension(s) into profile "${profile.name}": ${missingGallery.length} from gallery, ${missingVsix.length} from VSIX`);

		if (missingGallery.length > 0) {
			if (!this.extensionGalleryService.isEnabled()) {
				throw new Error('Extension gallery is disabled — cannot backfill core extensions from gallery');
			}

			const galleryExtensions = await this.extensionGalleryService.getExtensions(
				missingGallery.map(id => ({ id })),
				CancellationToken.None
			);

			for (const id of missingGallery) {
				if (!current()) { return; }
				const galleryExt = galleryExtensions.find(e => e.identifier.id.toLowerCase() === id.toLowerCase());
				if (!galleryExt) {
					throw new Error(`Core extension "${id}" not found in gallery`);
				}

				try {
					// See installPinnedExtensions for why
					// `isApplicationScoped: false` is explicit.
					await this.extensionManagementService.installFromGallery(galleryExt, {
						profileLocation: profile.extensionsResource,
						isApplicationScoped: false,
						isMachineScoped: true
					});
					this.logService.info(`[CodexConductor] Backfilled "${galleryExt.identifier.id}" v${galleryExt.version} from gallery`);
				} catch (err) {
					this.logService.error(`[CodexConductor] Failed to backfill "${galleryExt.identifier.id}" from gallery`, err);
					throw err;
				}
			}
		}

		if (missingVsix.length > 0) {
			const channel = this.sharedProcessService.getChannel('extensions');
			for (const entry of missingVsix) {
				if (!current()) { return; }
				try {
					// See installPinnedExtensions for why
					// `isApplicationScoped: false` is explicit.
					await channel.call('install', [URI.parse(entry.vsix), {
						installGivenVersion: true,
						pinned: true,
						isApplicationScoped: false,
						isMachineScoped: true,
						profileLocation: profile.extensionsResource,
					}]);
					this.logService.info(`[CodexConductor] Backfilled "${entry.id}" v${entry.version} from VSIX ${entry.vsix}`);
				} catch (err) {
					this.logService.error(`[CodexConductor] Failed to backfill "${entry.id}" from VSIX ${entry.vsix}`, err);
					throw err;
				}
			}
		}
	}
}
