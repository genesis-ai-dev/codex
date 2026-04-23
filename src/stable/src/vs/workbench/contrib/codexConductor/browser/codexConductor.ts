/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frontier R&D Ltd. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService, WorkbenchState, toWorkspaceIdentifier, isSingleFolderWorkspaceIdentifier } from '../../../../platform/workspace/common/workspace.js';
import { IUserDataProfileService } from '../../../services/userDataProfile/common/userDataProfile.js';
import { IUserDataProfile, IUserDataProfilesService } from '../../../../platform/userDataProfile/common/userDataProfile.js';
import { IWorkbenchExtensionManagementService } from '../../../services/extensionManagement/common/extensionManagement.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { URI } from '../../../../base/common/uri.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { joinPath } from '../../../../base/common/resources.js';
import { IHostService } from '../../../services/host/browser/host.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { OS, OperatingSystem } from '../../../../base/common/platform.js';
import { timeout } from '../../../../base/common/async.js';
import { PinnedExtensions, RequiredExtensions, ProjectMetadata, parsePinnedExtensions } from './codexTypes.js';

/** Maps profile name → array of project folder URIs that reference it. */
type ProfileAssociations = Record<string, string[]>;

const CODEX_EDITOR_EXTENSION_ID = 'project-accelerate.codex-editor-extension';
const CIRCUIT_BREAKER_KEY = 'codex.conductor.enforcementAttempts';
const CIRCUIT_BREAKER_MAX = 3;
const CIRCUIT_BREAKER_WINDOW_MS = 30_000;
const CONDUCTOR_PROFILE_ICON = 'repo-pinned';
const FRONTIER_EXTENSION_ID = 'frontier-rnd.frontier-authentication';
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
	private lastSeenPinsSnapshot: string | undefined;
	private readonly syncCompletionListener = this._register(new DisposableStore());

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IUserDataProfileService private readonly userDataProfileService: IUserDataProfileService,
		@IUserDataProfilesService private readonly userDataProfilesService: IUserDataProfilesService,
		@IWorkbenchExtensionManagementService private readonly extensionManagementService: IWorkbenchExtensionManagementService,
		@IStorageService private readonly storageService: IStorageService,
		@INotificationService private readonly notificationService: INotificationService,
		@IHostService private readonly hostService: IHostService,
		@ILogService private readonly logService: ILogService,
		@ISharedProcessService private readonly sharedProcessService: ISharedProcessService,
		@IDialogService private readonly dialogService: IDialogService,
		@IClipboardService private readonly clipboardService: IClipboardService,
		@IProductService private readonly productService: IProductService,
	) {
		super();

		this._register(CommandsRegistry.registerCommand('codex.conductor.cleanupProfiles', () => this.runProfileCleanup()));
		this._register(CommandsRegistry.registerCommand('codex.conductor.getEffectivePinnedExtensions', () => this.readEffectivePinsInternal()));
		
		this._register(CommandsRegistry.registerCommand('codex.conductor.setAdminPinIntent', (_accessor, pins: PinnedExtensions) => {
			this.storageService.store(ADMIN_PINNED_EXTENSIONS_KEY, JSON.stringify(pins), StorageScope.WORKSPACE, StorageTarget.MACHINE);
		}));

		this._register(CommandsRegistry.registerCommand('codex.conductor.clearAdminPinIntent', () => {
			this.storageService.remove(ADMIN_PINNED_EXTENSIONS_KEY, StorageScope.WORKSPACE);
		}));

		this._register(CommandsRegistry.registerCommand('codex.conductor.hasAdminPinIntent', () => {
			const raw = this.storageService.get(ADMIN_PINNED_EXTENSIONS_KEY, StorageScope.WORKSPACE);
			return !!raw;
		}));

		this._register(CommandsRegistry.registerCommand('codex.conductor.setRemotePins', (_accessor, pins: PinnedExtensions | null | undefined) => {
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

		this._register(this.workspaceContextService.onDidChangeWorkbenchState(() => this.initialize()));

		this.initialize();
	}

	private async initialize(): Promise<void> {
		if (this.workspaceContextService.getWorkbenchState() !== WorkbenchState.FOLDER) {
			this.metadataUri = undefined;
			await this.revertIfPatchBuild();
			return;
		}

		const workspaceFolder = this.workspaceContextService.getWorkspace().folders[0];
		this.metadataUri = joinPath(workspaceFolder.uri, 'metadata.json');

		// Snapshot current pins before enforcement
		this.lastSeenPinsSnapshot = await this.readPinsSnapshot();

		// Backfill: if we're already sitting on a conductor profile (no reload
		// needed this session), make sure its settings still disable update
		// checks. Handles users whose profiles were created before this change.
		const currentProfile = this.userDataProfileService.currentProfile;
		if (currentProfile.icon === CONDUCTOR_PROFILE_ICON) {
			await this.seedProfileSettings(currentProfile);
		}

		// Run initial enforcement
		await this.enforce();

		// Periodic profile cleanup (every 14 days)
		await this.maybeCleanupOrphanedProfiles();

		// Listen for sync completions from Frontier
		this.listenForSyncCompletion();

		await this.logStartupExtensionState();
	}

	// ── Mid-session signals ────────────────────────────────────────────

	/**
	 * Listens for Frontier's workspace state changes via IStorageService.
	 * When Frontier writes to its workspaceState (e.g. after a sync), this fires.
	 * We then check if pinnedExtensions in metadata.json have changed and prompt
	 * the user to reload if so.
	 */
	private listenForSyncCompletion(): void {
		this.syncCompletionListener.clear();

		const storageListener = this.storageService.onDidChangeValue(
			StorageScope.WORKSPACE,
			undefined, // listen to all keys in this scope
			this.syncCompletionListener
		)((e) => {
			if (e.key === REMOTE_PINNED_EXTENSIONS_KEY || e.key === SYNC_COMPLETED_AT_KEY || e.key === ADMIN_PINNED_EXTENSIONS_KEY) {
				this.checkForPinChanges();
			}
		});

		this.syncCompletionListener.add(storageListener);
	}

	private async checkForPinChanges(): Promise<void> {
		const currentSnapshot = await this.readPinsSnapshot();
		if (currentSnapshot === this.lastSeenPinsSnapshot) {
			return;
		}

		this.lastSeenPinsSnapshot = currentSnapshot;

		if (!currentSnapshot) {
			// Pins were removed — prompt reload to revert to default profile.
			// Use switchProfileAndReload() so the workspace-profile association
			// is persisted (not just the immediate reload target).
			const defaultProfile = this.userDataProfilesService.profiles.find(p => p.isDefault);
			if (!defaultProfile) { return; }
			this.notificationService.prompt(
				Severity.Info,
				'Extension version pins have been removed. Reload to revert to the default profile.',
				[{
					label: 'Reload Codex',
					run: () => this.switchProfileAndReload(defaultProfile)
				}]
			);
			return;
		}

		// New or changed pins — need to prepare the profile before reloading.
		let pins: PinnedExtensions;
		try {
			const parsed = parsePinnedExtensions(JSON.parse(currentSnapshot));
			if (!parsed) { return; }
			pins = parsed;
		} catch {
			return;
		}

		const targetProfileName = this.resolveProfileName(pins);
		const existingProfile = this.userDataProfilesService.profiles.find(p => p.name === targetProfileName);

		if (existingProfile && await this.validateProfileExtensions(existingProfile, pins)) {
			// Profile already exists and is complete — prompt reload via switchProfileAndReload()
			// which persists the workspace-profile association before reloading.
			this.notificationService.prompt(
				Severity.Info,
				'Pinned extension installed. Reload to apply.',
				[{
					label: 'Reload Codex',
					run: () => this.switchProfileAndReload(existingProfile)
				}]
			);
			return;
		}

		if (existingProfile) {
			this.logService.warn(`[CodexConductor] Profile "${targetProfileName}" exists but is missing pinned extensions — repairing`);
		}

		// Profile doesn't exist or is incomplete — download and install, then prompt.
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
			// Reuse the existing incomplete profile or create a new one.
			const profile = existingProfile
				?? await this.userDataProfilesService.createNamedProfile(targetProfileName, { icon: CONDUCTOR_PROFILE_ICON });

			try {
				await this.installPinnedExtensions(pins, profile);
			} catch (e: unknown) {
				// Installation failed after all retries — cleanup the incomplete profile
				// (only if it's not the current profile, which cannot be deleted).
				if (profile.id !== this.userDataProfileService.currentProfile.id) {
					try {
						await this.userDataProfilesService.removeProfile(profile);
						this.logService.info(`[CodexConductor] Cleaned up incomplete profile "${targetProfileName}" after installation failure`);
					} catch (cleanupError) {
						this.logService.warn(`[CodexConductor] Failed to clean up incomplete profile "${targetProfileName}": ${cleanupError}`);
					}
				}
				throw e;
			}

			handle.close();

			if (reloadWhenReady) {
				// User already opted in — reload immediately
				await this.switchProfileAndReload(profile);
			} else {
				// Show completion notification with reload button
				this.notificationService.prompt(
					Severity.Info,
					'Pinned extension installed. Reload to apply.',
					[{
						label: 'Reload Codex',
						run: () => this.switchProfileAndReload(profile)
					}]
				);
			}
		} catch (e: unknown) {
			handle.close();
			this.notificationService.prompt(
				Severity.Error,
				'Failed to install pinned extension.',
				[{
					label: 'Copy Error Report',
					run: () => this.showErrorReport(pins, e)
				}]
			);
		}
	}

	private async installPinnedExtensions(pins: PinnedExtensions, profile: IUserDataProfile): Promise<void> {
		// Use the shared process 'extensions' IPC channel directly to bypass
		// NativeExtensionManagementService.downloadVsix(), which downloads in the
		// renderer using browser fetch() — that fails for GitHub release URLs due
		// to CORS on the 302 redirect. The shared process downloads via Node.js
		// networking which handles redirects without CORS restrictions.
		const channel = this.sharedProcessService.getChannel('extensions');

		for (const [id, pin] of Object.entries(pins)) {
			let lastError: Error | undefined;
			for (let attempt = 1; attempt <= 3; attempt++) {
				try {
					this.logService.info(`[CodexConductor] Installing pinned VSIX for "${id}" v${pin.version} from ${pin.url} (attempt ${attempt}/3)`);

					await channel.call('install', [URI.parse(pin.url), {
						installGivenVersion: true,
						pinned: true,
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

	/**
	 * Returns a stable JSON snapshot of currently active pins from the prioritized
	 * source (local metadata.json or remote storage).
	 */
	private async readPinsSnapshot(): Promise<string | undefined> {
		const pins = await this.readEffectivePinsInternal();
		if (!pins) { return undefined; }
		// Canonicalize both top-level key order and nested entry field order
		// so the snapshot is stable regardless of parse/write iteration order.
		const sorted = Object.keys(pins).sort().reduce<PinnedExtensions>((acc, k) => {
			const e = pins[k];
			acc[k] = { url: e.url, version: e.version };
			return acc;
		}, {});
		return JSON.stringify(sorted);
	}

	private async logStartupExtensionState(): Promise<void> {
		const installed = await this.extensionManagementService.getInstalled();
		const codexEditorVersion = installed.find(e => e.identifier.id.toLowerCase() === CODEX_EDITOR_EXTENSION_ID)?.manifest.version ?? 'not installed';
		const frontierAuthVersion = installed.find(e => e.identifier.id.toLowerCase() === FRONTIER_EXTENSION_ID)?.manifest.version ?? 'not installed';
		const currentProfileName = this.userDataProfileService.currentProfile.name;
		const requiredExtensions = await this.readRequiredExtensionsFromMetadata();
		const pinnedExtensions = await this.readEffectivePinnedExtensions();

		this.logService.info(
			`[CodexConductor] Startup extension state — profile=${currentProfileName}, ${CODEX_EDITOR_EXTENSION_ID}=${codexEditorVersion}, ${FRONTIER_EXTENSION_ID}=${frontierAuthVersion}, pinnedExtensions=${this.formatObjectForLog(pinnedExtensions)}, requiredExtensions=${this.formatObjectForLog(requiredExtensions)}`
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
	 * 1. Admin Intent (adminPinnedExtensions in storage) - Absolute precedence.
	 * 2. Remote Pins (remotePinnedExtensions in storage) - Authoritative for users.
	 * 3. Local Pins (metadata.json on disk) - Fallback.
	 */
	private async readEffectivePinsInternal(): Promise<PinnedExtensions | undefined> {
		// 1. Check Admin Intent (highest precedence)
		const rawAdmin = this.storageService.get(ADMIN_PINNED_EXTENSIONS_KEY, StorageScope.WORKSPACE);
		if (rawAdmin) {
			try {
				const adminIntent = parsePinnedExtensions(JSON.parse(rawAdmin));
				if (adminIntent) {
					// We only honor the intent if it matches what's currently running.
					// This prevents "intent leakage" if the admin manually changes
					// extensions without using the conductor.
					const installed = await this.extensionManagementService.getInstalled();
					let matchesRunning = true;
					for (const [id, pin] of Object.entries(adminIntent)) {
						const ext = installed.find(e => e.identifier.id.toLowerCase() === id.toLowerCase());
						if (!ext || ext.manifest.version !== pin.version) {
							matchesRunning = false;
							break;
						}
					}

					if (matchesRunning) {
						this.logService.trace('[CodexConductor] Admin intent active and matches running version — prioritizing.');
						return adminIntent;
					}
				}
			} catch {
				this.logService.warn('[CodexConductor] Malformed admin intent in storage');
			}
		}

		// 2. Check Remote Pins (authoritative for users)
		const rawRemote = this.storageService.get(REMOTE_PINNED_EXTENSIONS_KEY, StorageScope.WORKSPACE);
		if (rawRemote) {
			try {
				const remotePins = parsePinnedExtensions(JSON.parse(rawRemote));
				if (remotePins) {
					this.logService.trace('[CodexConductor] Remote pins found in storage — prioritizing over metadata.json');
					return remotePins;
				}
			} catch {
				this.logService.warn('[CodexConductor] Malformed remote pins in storage');
			}
		}

		// 3. Fall back to metadata.json on disk
		const metadata = await this.readProjectMetadata();
		return parsePinnedExtensions(metadata?.meta?.pinnedExtensions);
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

	// ── Enforcement ────────────────────────────────────────────────────

	private async enforce(): Promise<void> {
		if (!this.metadataUri) {
			return;
		}

		const workspaceFolder = this.workspaceContextService.getWorkspace().folders[0];
		const pins = await this.readEffectivePinsInternal();

		if (!pins) {
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
					run: () => this.showErrorReport(pins, undefined, mismatches)
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
			if (await this.validateProfileExtensions(existingProfile, pins)) {
				// Profile is complete — just switch.
				this.logService.info(`[CodexConductor] Profile "${targetProfileName}" already exists and is complete — switching without download`);
				await this.switchProfileAndReload(existingProfile);
				return;
			}
			// Profile exists but is incomplete (interrupted install?) — repair it.
			this.logService.warn(`[CodexConductor] Profile "${targetProfileName}" exists but is missing pinned extensions — repairing`);
		}

		// Reuse the existing incomplete profile or create a new one.
		const profile = existingProfile
			?? await this.userDataProfilesService.createNamedProfile(targetProfileName, { icon: CONDUCTOR_PROFILE_ICON });

		try {
			await this.installPinnedExtensions(pins, profile);
		} catch (e: unknown) {
			// Installation failed after all retries — cleanup the incomplete profile
			// (only if it's not the current profile, which cannot be deleted).
			if (profile.id !== this.userDataProfileService.currentProfile.id) {
				try {
					await this.userDataProfilesService.removeProfile(profile);
					this.logService.info(`[CodexConductor] Cleaned up incomplete profile "${targetProfileName}" after installation failure`);
				} catch (cleanupError) {
					this.logService.warn(`[CodexConductor] Failed to clean up incomplete profile "${targetProfileName}": ${cleanupError}`);
				}
			}

			this.notificationService.prompt(
				Severity.Error,
				'Failed to install pinned extension.',
				[{
					label: 'Open in Default Profile',
					run: () => this.switchToDefaultProfile()
				}, {
					label: 'Copy Error Report',
					run: () => this.showErrorReport(pins, e)
				}]
			);
			return;
		}

		await this.switchProfileAndReload(profile);
	}

	private async revertIfPatchBuild(): Promise<void> {
		if (this.userDataProfileService.currentProfile.isDefault) {
			return;
		}

		// Only revert if the current profile was created by the conductor
		const currentProfile = this.userDataProfileService.currentProfile;
		if (currentProfile.icon !== CONDUCTOR_PROFILE_ICON) {
			return;
		}

		const defaultProfile = this.userDataProfilesService.profiles.find(p => p.isDefault);
		if (defaultProfile) {
			this.logService.info(`[CodexConductor] No active pins — reverting from "${currentProfile.name}" to default profile`);
			await this.switchProfileAndReload(defaultProfile);
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

	// ── Error reporting ────────────────────────────────────────────────

	private async showErrorReport(pins: PinnedExtensions, error?: unknown, mismatches?: string[]): Promise<void> {
		const osName = OS === OperatingSystem.Macintosh ? 'macOS' : OS === OperatingSystem.Windows ? 'Windows' : 'Linux';
		const workspaceFolder = this.workspaceContextService.getWorkspace().folders[0];

		const report = [
			'--- Codex Conductor Error Report ---',
			'',
			`Codex Version: ${this.productService.version || 'unknown'} (${this.productService.commit?.slice(0, 8) || 'unknown'})`,
			`OS: ${osName}`,
			`Profile: ${this.userDataProfileService.currentProfile.name}`,
			`Project: ${workspaceFolder?.name || 'unknown'}`,
			`Online: ${navigator.onLine}`,
			'',
		];

		if (error) {
			const message = error instanceof Error ? error.message : String(error);
			const code = (error as any).code ? ` [Code: ${(error as any).code}]` : '';
			const extensionId = (error as any).extensionId ? ` [Extension: ${(error as any).extensionId}]` : '';
			const url = (error as any).url ? ` [URL: ${(error as any).url}]` : '';

			report.push('Error:');
			report.push(`  - ${message}${code}${extensionId}${url}`);
			report.push('');
		}

		if (mismatches && mismatches.length > 0) {
			report.push('Mismatches:');
			report.push(...mismatches.map(m => `  - ${m}`));
			report.push('');
		}

		report.push('Pinned Extensions:');
		report.push(...Object.entries(pins).map(([id, pin]) =>
			`  - ${id}: v${pin.version} (${pin.url})`
		));
		report.push('');
		report.push('---');

		const fullReport = report.join('\n');

		const { result } = await this.dialogService.prompt({
			type: Severity.Error,
			message: 'Something went wrong while switching profiles',
			detail: fullReport,
			buttons: [
				{ label: 'Copy to Clipboard', run: () => true },
			],
			cancelButton: 'Close',
		});

		if (await result) {
			await this.clipboardService.writeText(fullReport);
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
			for (const [id, pin] of Object.entries(pins)) {
				const ext = installed.find(e => e.identifier.id.toLowerCase() === id.toLowerCase());
				if (!ext || ext.manifest.version !== pin.version) {
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

	/**
	 * Seeds a conductor-managed profile's settings.json with the keys needed to
	 * keep pinned extensions stable: disables the marketplace update check and
	 * auto-update for that profile only. Idempotent — merges with any existing
	 * profile settings and skips the write when the desired values are already
	 * present. Requires the companion patch that drops APPLICATION scope from
	 * `extensions.autoCheckUpdates` / `extensions.autoUpdate` so that profile
	 * settings can override the user-level defaults.
	 */
	private async seedProfileSettings(profile: IUserDataProfile): Promise<void> {
		if (profile.icon !== CONDUCTOR_PROFILE_ICON) {
			return;
		}

		const uri = profile.settingsResource;
		let existing: Record<string, unknown> = {};
		try {
			const buf = await this.fileService.readFile(uri);
			const text = buf.value.toString().trim();
			if (text) {
				const parsed: unknown = JSON.parse(text);
				if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
					existing = parsed as Record<string, unknown>;
				}
			}
		} catch {
			// No settings file yet, or unparseable — start fresh. We deliberately
			// overwrite a malformed file because a conductor profile has no
			// user-authored settings we need to preserve.
		}

		if (
			existing['extensions.autoCheckUpdates'] === false
			&& existing['extensions.autoUpdate'] === false
		) {
			return;
		}

		const next = {
			...existing,
			'extensions.autoCheckUpdates': false,
			'extensions.autoUpdate': false,
		};

		try {
			await this.fileService.writeFile(uri, VSBuffer.fromString(JSON.stringify(next, null, 4)));
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
	 */
	private async switchProfileAndReload(profile: IUserDataProfile): Promise<void> {
		const workspace = this.workspaceContextService.getWorkspace();
		const workspaceIdentifier = toWorkspaceIdentifier(workspace);
		const originalProfileId = this.userDataProfileService.currentProfile.id;
		const currentProfileName = this.userDataProfileService.currentProfile.name;

		this.logService.info(`[CodexConductor] switchProfileAndReload: current=${currentProfileName}, target=${profile.name}`);

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
		await this.userDataProfilesService.setProfileForWorkspace(workspaceIdentifier, profile);
		this.logService.info(`[CodexConductor] setProfileForWorkspace completed`);

		// Compare against the profile ID captured BEFORE setProfileForWorkspace.
		// setProfileForWorkspace may internally trigger changeCurrentProfile which
		// updates currentProfile even if the extension host vetos the switch. Using
		// the post-call currentProfile.id would incorrectly skip the reload.
		if (originalProfileId !== profile.id) {
			this.logService.info(`[CodexConductor] Profile mismatch (${currentProfileName} != ${profile.name}) — triggering authoritative reload`);
			this.hostService.reload({ forceProfile: profile.name });
		} else {
			this.logService.info(`[CodexConductor] Already on target profile ${profile.name} — no reload needed`);
		}
	}

	private async switchToDefaultProfile(): Promise<void> {
		const profile = this.userDataProfilesService.profiles.find(p => p.isDefault);
		if (profile) {
			await this.switchProfileAndReload(profile);
		}
	}
}
