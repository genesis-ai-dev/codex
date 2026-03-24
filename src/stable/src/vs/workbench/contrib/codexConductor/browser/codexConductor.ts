/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frontier R&D Ltd. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService, WorkbenchState } from '../../../../platform/workspace/common/workspace.js';
import { IUserDataProfileManagementService, IUserDataProfileService } from '../../../services/userDataProfile/common/userDataProfile.js';
import { IUserDataProfilesService } from '../../../../platform/userDataProfile/common/userDataProfile.js';
import { IExtensionManagementServerService, IWorkbenchExtensionManagementService } from '../../../services/extensionManagement/common/extensionManagement.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { URI } from '../../../../base/common/uri.js';
import { joinPath } from '../../../../base/common/resources.js';
import { IHostService } from '../../../services/host/browser/host.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { OS, OperatingSystem } from '../../../../base/common/platform.js';

interface PinnedExtensionEntry {
	version: string;
	url: string;
}

type PinnedExtensions = Record<string, PinnedExtensionEntry>;

/** Maps profile name → array of project folder URIs that reference it. */
type ProfileAssociations = Record<string, string[]>;

const CIRCUIT_BREAKER_KEY = 'codex.conductor.enforcementAttempts';
const CIRCUIT_BREAKER_MAX = 3;
const CIRCUIT_BREAKER_WINDOW_MS = 30_000;
const CONDUCTOR_PROFILE_PATTERN = /^.+-v\d+\.\d+\.\d+(\+[0-9a-f]{4})?$/;
const FRONTIER_EXTENSION_ID = 'frontier-rnd.frontier-authentication';
const PROFILE_ASSOCIATIONS_KEY = 'codex.conductor.profileAssociations';
const LAST_CLEANUP_KEY = 'codex.conductor.lastCleanup';
const CLEANUP_INTERVAL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

/** Strip publisher prefix and common suffixes to get a short profile-friendly name. */
function shortName(extensionId: string): string {
	const afterDot = extensionId.includes('.') ? extensionId.slice(extensionId.indexOf('.') + 1) : extensionId;
	return afterDot.replace(/-extension$/, '');
}

export class CodexConductorContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.codexConductor';

	private metadataUri: URI | undefined;
	private lastSeenPinsSnapshot: string | undefined;

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IUserDataProfileService private readonly userDataProfileService: IUserDataProfileService,
		@IUserDataProfilesService private readonly userDataProfilesService: IUserDataProfilesService,
		@IUserDataProfileManagementService private readonly userDataProfileManagementService: IUserDataProfileManagementService,
		@IWorkbenchExtensionManagementService private readonly extensionManagementService: IWorkbenchExtensionManagementService,
		@IStorageService private readonly storageService: IStorageService,
		@INotificationService private readonly notificationService: INotificationService,
		@IHostService private readonly hostService: IHostService,
		@ILogService private readonly logService: ILogService,
		@IDialogService private readonly dialogService: IDialogService,
		@IClipboardService private readonly clipboardService: IClipboardService,
		@IProductService private readonly productService: IProductService,
		@IExtensionManagementServerService private readonly extensionManagementServerService: IExtensionManagementServerService
	) {
		super();

		this._register(CommandsRegistry.registerCommand('codex.conductor.cleanupProfiles', () => this.runProfileCleanup()));

		this.initialize();
	}

	private async initialize(): Promise<void> {
		if (this.workspaceContextService.getWorkbenchState() !== WorkbenchState.FOLDER) {
			return;
		}

		const workspaceFolder = this.workspaceContextService.getWorkspace().folders[0];
		this.metadataUri = joinPath(workspaceFolder.uri, 'metadata.json');

		// Snapshot current pins before enforcement
		this.lastSeenPinsSnapshot = await this.readPinsSnapshot();

		// Run initial enforcement
		await this.enforce();

		// Periodic profile cleanup (every 14 days)
		await this.maybeCleanupOrphanedProfiles();

		// Listen for sync completions from Frontier
		this.listenForSyncCompletion();
	}

	// ── Mid-session signals ────────────────────────────────────────────

	/**
	 * Listens for Frontier's workspace state changes via IStorageService.
	 * When Frontier writes to its workspaceState (e.g. after a sync), this fires.
	 * We then check if pinnedExtensions in metadata.json have changed and prompt
	 * the user to reload if so.
	 */
	private listenForSyncCompletion(): void {
		const storageListener = this._register(new DisposableStore());

		this._register(this.storageService.onDidChangeValue(
			StorageScope.WORKSPACE,
			FRONTIER_EXTENSION_ID,
			storageListener
		)(() => {
			this.checkForPinChanges();
		}));
	}

	private async checkForPinChanges(): Promise<void> {
		const currentSnapshot = await this.readPinsSnapshot();
		if (currentSnapshot === this.lastSeenPinsSnapshot) {
			return;
		}

		this.lastSeenPinsSnapshot = currentSnapshot;

		if (!currentSnapshot) {
			// Pins were removed — prompt a simple reload to revert profile
			this.notificationService.prompt(
				Severity.Info,
				'Extension version pins have been removed. Reload to revert to the default profile.',
				[{
					label: 'Reload Codex',
					run: () => this.hostService.reload()
				}]
			);
			return;
		}

		// New or changed pins — need to prepare the profile before reloading.
		let pins: PinnedExtensions;
		try {
			pins = JSON.parse(currentSnapshot);
		} catch {
			return;
		}

		const targetProfileName = this.resolveProfileName(pins);
		const existingProfile = this.userDataProfilesService.profiles.find(p => p.name === targetProfileName);

		if (existingProfile) {
			// Profile already exists — just prompt reload
			this.notificationService.prompt(
				Severity.Info,
				'Pinned extension installed. Reload to apply.',
				[{
					label: 'Reload Codex',
					run: () => this.hostService.reload()
				}]
			);
			return;
		}

		// Profile doesn't exist — download and install, then prompt.
		// Show progress notification with "Reload Codex When Ready" option.
		let reloadWhenReady = false;

		const handle = this.notificationService.prompt(
			Severity.Info,
			'Installing pinned extension\u2026',
			[{
				label: 'Reload Codex When Ready',
				run: () => { reloadWhenReady = true; }
			}]
		);
		handle.progress.infinite();

		try {
			const profile = await this.userDataProfilesService.createNamedProfile(targetProfileName);

			const localServer = this.extensionManagementServerService.localExtensionManagementServer;
			if (!localServer) {
				handle.close();
				this.logService.error('[CodexConductor] No local extension management server available');
				return;
			}

			for (const [id, pin] of Object.entries(pins)) {
				this.logService.info(`[CodexConductor] Installing pinned VSIX for "${id}" v${pin.version} from ${pin.url}`);
				await localServer.extensionManagementService.install(URI.parse(pin.url), {
					installGivenVersion: true,
					profileLocation: profile.extensionsResource
				});
			}

			handle.close();

			if (reloadWhenReady) {
				// User already opted in — reload immediately
				this.hostService.reload();
			} else {
				// Show completion notification with reload button
				this.notificationService.prompt(
					Severity.Info,
					'Pinned extension installed. Reload to apply.',
					[{
						label: 'Reload Codex',
						run: () => this.hostService.reload()
					}]
				);
			}
		} catch (e: unknown) {
			handle.close();
			const message = e instanceof Error ? e.message : String(e);
			this.notificationService.error(`Failed to install pinned extension: ${message}`);
		}
	}

	/**
	 * Reads pinnedExtensions from storage (remotePinnedExtensions written by
	 * Frontier) first, then falls back to metadata.json on disk. Returns a
	 * stable JSON string for snapshot comparison, or undefined if no pins found.
	 */
	private async readPinsSnapshot(): Promise<string | undefined> {
		// Storage first — this has the latest pins from origin even if sync
		// aborted before merging metadata.json to disk.
		const storagePins = this.readPinsFromStorage();
		if (storagePins) {
			return storagePins;
		}

		// Fall back to metadata.json on disk
		if (!this.metadataUri) {
			return undefined;
		}
		try {
			const content = await this.fileService.readFile(this.metadataUri);
			const metadata = JSON.parse(content.value.toString());
			const pins = metadata?.meta?.pinnedExtensions;
			return pins ? JSON.stringify(pins) : undefined;
		} catch {
			return undefined;
		}
	}

	/**
	 * Reads remotePinnedExtensions from Frontier's workspaceState via
	 * IStorageService. Returns the raw JSON string or undefined.
	 */
	private readPinsFromStorage(): string | undefined {
		const raw = this.storageService.get(
			`${FRONTIER_EXTENSION_ID}.remotePinnedExtensions`,
			StorageScope.WORKSPACE
		);
		if (!raw) {
			return undefined;
		}
		// Validate it parses and has entries
		try {
			const pins = JSON.parse(raw);
			if (pins && typeof pins === 'object' && Object.keys(pins).length > 0) {
				return raw;
			}
		} catch {
			// Malformed — ignore
		}
		return undefined;
	}

	// ── Enforcement ────────────────────────────────────────────────────

	private async enforce(): Promise<void> {
		if (!this.metadataUri) {
			return;
		}

		const workspaceFolder = this.workspaceContextService.getWorkspace().folders[0];

		// Read pins from storage first (remotePinnedExtensions written by Frontier),
		// then fall back to metadata.json on disk. Storage has the latest pins from
		// origin even if sync aborted before merging metadata.json to disk.
		let pins: PinnedExtensions = {};

		const storagePins = this.readPinsFromStorage();
		if (storagePins) {
			try {
				pins = JSON.parse(storagePins);
			} catch {
				this.logService.warn('[CodexConductor] Malformed remotePinnedExtensions in storage');
			}
		}

		if (Object.keys(pins).length === 0) {
			// No pins in storage — try metadata.json on disk
			try {
				const content = await this.fileService.readFile(this.metadataUri);
				let metadata: unknown;
				try {
					metadata = JSON.parse(content.value.toString());
				} catch (parseError) {
					this.logService.warn('[CodexConductor] metadata.json contains invalid JSON — extension pinning disabled');
					return;
				}
				pins = (metadata as { meta?: { pinnedExtensions?: PinnedExtensions } })?.meta?.pinnedExtensions || {};
			} catch (e) {
				// No metadata.json — not a Codex project, nothing to enforce
				this.logService.trace('[CodexConductor] No metadata.json found — skipping enforcement');
				return;
			}
		}

		if (Object.keys(pins).length === 0) {
			// No active pins — remove this project from any profile associations
			this.removeCurrentProjectFromAssociations();
			await this.revertIfPatchBuild();
			return;
		}

		await this.enforcePins(pins, workspaceFolder.uri);
	}

	private async enforcePins(pins: PinnedExtensions, workspaceUri: URI): Promise<void> {
		const installed = await this.extensionManagementService.getInstalled();
		const mismatches: string[] = [];

		for (const [id, pin] of Object.entries(pins)) {
			const ext = installed.find(e => e.identifier.id.toLowerCase() === id.toLowerCase());
			if (!ext || ext.manifest.version !== pin.version) {
				mismatches.push(`${id}: expected ${pin.version}, found ${ext?.manifest.version || 'none'}`);
			}
		}

		if (mismatches.length === 0) {
			return;
		}

		if (this.checkCircuitBreaker()) {
			this.notificationService.prompt(
				Severity.Error,
				'Something went wrong while switching profiles.',
				[{
					label: 'Open in Default Profile',
					run: () => this.switchToDefaultProfile()
				}, {
					label: 'Copy Error Report',
					run: () => this.showErrorReport(mismatches, pins)
				}]
			);
			return;
		}

		const targetProfileName = this.resolveProfileName(pins);
		this.recordAttempt();

		// Track this project's association with the profile
		this.addProfileAssociation(targetProfileName, workspaceUri.toString());

		this.logService.info(`[CodexConductor] Switching to profile "${targetProfileName}" — version pin active`);

		const existingProfile = this.userDataProfilesService.profiles.find(p => p.name === targetProfileName);
		if (existingProfile) {
			// Profile already exists with the correct name — the name is deterministic
			// ({shortName}-v{version}) so a name match guarantees the correct extensions
			// are installed. Skip download/install and just switch.
			this.logService.info(`[CodexConductor] Profile "${targetProfileName}" already exists — switching without download`);
			await this.userDataProfileManagementService.switchProfile(existingProfile);
			return;
		}

		const profile = await this.userDataProfilesService.createNamedProfile(targetProfileName);

		const localServer = this.extensionManagementServerService.localExtensionManagementServer;
		if (!localServer) {
			this.logService.error('[CodexConductor] No local extension management server available');
			return;
		}

		for (const [id, pin] of Object.entries(pins)) {
			try {
				this.logService.info(`[CodexConductor] Installing pinned VSIX for "${id}" v${pin.version} from ${pin.url}`);
				// Pass the HTTP URI directly to the extension management server.
				// On desktop, this routes through IPC to the shared process which
				// downloads via Node.js/Electron net (handles redirects properly).
				await localServer.extensionManagementService.install(URI.parse(pin.url), {
					installGivenVersion: true,
					profileLocation: profile.extensionsResource
				});
			} catch (e: unknown) {
				const message = e instanceof Error ? e.message : String(e);
				this.notificationService.error(`Failed to install pinned extension ${id}: ${message}`);
				return;
			}
		}

		await this.userDataProfileManagementService.switchProfile(profile);
	}

	private async revertIfPatchBuild(): Promise<void> {
		if (this.userDataProfileService.currentProfile.isDefault) {
			return;
		}

		// Only revert if the current profile looks like a conductor-managed profile
		const profileName = this.userDataProfileService.currentProfile.name;
		if (!CONDUCTOR_PROFILE_PATTERN.test(profileName)) {
			return;
		}

		const defaultProfile = this.userDataProfilesService.profiles.find(p => p.isDefault);
		if (defaultProfile) {
			this.logService.info(`[CodexConductor] No active pins — reverting from "${profileName}" to default profile`);
			await this.userDataProfileManagementService.switchProfile(defaultProfile);
		}
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
			p => !p.isDefault && CONDUCTOR_PROFILE_PATTERN.test(p.name)
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
				const pins: PinnedExtensions = metadata?.meta?.pinnedExtensions || {};

				if (Object.keys(pins).length > 0 && this.resolveProfileName(pins) === profileName) {
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

	// ── Error reporting ────────────────────────────────────────────────

	private async showErrorReport(mismatches: string[], pins: PinnedExtensions): Promise<void> {
		const osName = OS === OperatingSystem.Macintosh ? 'macOS' : OS === OperatingSystem.Windows ? 'Windows' : 'Linux';
		const workspaceFolder = this.workspaceContextService.getWorkspace().folders[0];

		const report = [
			'--- Codex Conductor Error Report ---',
			'',
			`Codex Version: ${this.productService.version || 'unknown'} (${this.productService.commit?.slice(0, 8) || 'unknown'})`,
			`OS: ${osName}`,
			`Profile: ${this.userDataProfileService.currentProfile.name}`,
			`Project: ${workspaceFolder?.name || 'unknown'}`,
			'',
			'Mismatches:',
			...mismatches.map(m => `  - ${m}`),
			'',
			'Pinned Extensions:',
			...Object.entries(pins).map(([id, pin]) =>
				`  - ${id}: v${pin.version} (${pin.url})`
			),
			'',
			'---',
		].join('\n');

		const { result } = await this.dialogService.prompt({
			type: Severity.Error,
			message: 'Something went wrong while switching profiles',
			detail: report,
			buttons: [
				{ label: 'Copy to Clipboard', run: () => true },
			],
			cancelButton: 'Close',
		});

		if (await result) {
			await this.clipboardService.writeText(report);
		}
	}

	// ── Utilities ──────────────────────────────────────────────────────

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

	private checkCircuitBreaker(): boolean {
		const raw = this.storageService.get(CIRCUIT_BREAKER_KEY, StorageScope.WORKSPACE);
		if (!raw) { return false; }
		try {
			const attempts: number[] = JSON.parse(raw);
			const now = Date.now();
			const recent = attempts.filter(t => now - t < CIRCUIT_BREAKER_WINDOW_MS);
			return recent.length >= CIRCUIT_BREAKER_MAX;
		} catch {
			return false;
		}
	}

	private recordAttempt(): void {
		const raw = this.storageService.get(CIRCUIT_BREAKER_KEY, StorageScope.WORKSPACE);
		let attempts: number[];
		try {
			attempts = raw ? JSON.parse(raw) : [];
		} catch {
			attempts = [];
		}
		attempts.push(Date.now());
		// Prune old entries to prevent unbounded growth
		const now = Date.now();
		attempts = attempts.filter(t => now - t < CIRCUIT_BREAKER_WINDOW_MS);
		this.storageService.store(CIRCUIT_BREAKER_KEY, JSON.stringify(attempts), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}

	private async switchToDefaultProfile(): Promise<void> {
		const profile = this.userDataProfilesService.profiles.find(p => p.isDefault);
		if (profile) {
			await this.userDataProfileManagementService.switchProfile(profile);
		}
	}
}
