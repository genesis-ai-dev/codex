/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frontier R&D Ltd. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { IWorkbenchExtensionManagementService } from '../../../services/extensionManagement/common/extensionManagement.js';
import { IExtensionGalleryService } from '../../../../platform/extensionManagement/common/extensionManagement.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { IUserDataProfileService } from '../../../services/userDataProfile/common/userDataProfile.js';
import { IUserDataProfilesService } from '../../../../platform/userDataProfile/common/userDataProfile.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { ExtensionType } from '../../../../platform/extensions/common/extensions.js';
import { URI } from '../../../../base/common/uri.js';
import { SideloadEntry, SideloadVsixEntry, parseSideloadEntries } from '../../codexConductor/browser/codexTypes.js';

const TAG = '[CodexSideloader]';

/**
 * Why sideloaded extensions are NOT marked `isApplicationScoped`
 * --------------------------------------------------------------
 * An earlier iteration of this contribution (commit d9f6ee6, "feat: ensure
 * sideloaded extensions are application and machine scoped") set
 * `isApplicationScoped: true` on every sideloaded install. The motivation was
 * to make these extensions visible inside conductor-managed profiles —
 * VS Code's profile-extension scanner (`scanExtensionsFromProfile`) bridges
 * application-scoped entries from the Default profile into every other profile
 * automatically.
 *
 * That bridge has two problems for our use case:
 *
 *   1. When the Conductor later installs a *pinned* VSIX of the same extension
 *      into a conductor profile, the install task reads the existing app-scoped
 *      entry from the Default profile and inherits its `isApplicationScoped`
 *      flag (extensionManagementService.ts line 1047, `||` semantics). The new
 *      pinned install ends up app-scoped too, gets filtered out of the
 *      conductor profile by the scanner, and post-install verification throws
 *      "Cannot read the extension from …".
 *
 *   2. Even if the install succeeded, `dedupExtensions` prefers app-scoped over
 *      non-app-scoped, so the Default-profile sideloaded version would shadow
 *      the conductor's pin at runtime — the wrong version would actually run.
 *
 * The Conductor's `backfillCoreExtensions` (added in 5fd88fa) makes the bridge
 * unnecessary: every conductor profile now gets its *own* copies of the
 * sideloaded extensions, with full per-profile metadata. So we leave
 * `isApplicationScoped` unset (false) on sideloaded installs and rely on
 * backfill for cross-profile visibility.
 *
 * `isMachineScoped: true` is unrelated and stays — it suppresses Settings Sync
 * "Sync this extension?" prompts for product-managed extensions.
 *
 * Migration: legacy installs from before this fix have `isApplicationScoped:
 * true` in their metadata. `migrateLegacyAppScope()` runs on every window
 * (including conductor profiles, where the full sideload is skipped) and uses
 * `updateMetadata` to clear the flag in-place. This is faster and more reliable
 * than reinstall-based migration, and it runs in non-default profile windows
 * too — important because the user may never see a default-profile window
 * once the Conductor switches them to a pinned profile, and stale app-scope
 * data in the Default profile would otherwise still bleed into conductor
 * profiles via the cross-profile bridge.
 */
export class CodexSideloaderContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.codexSideloader';

	constructor(
		@IWorkbenchExtensionManagementService private readonly extensionManagementService: IWorkbenchExtensionManagementService,
		@IExtensionGalleryService private readonly extensionGalleryService: IExtensionGalleryService,
		@IProductService private readonly productService: IProductService,
		@ILogService private readonly logService: ILogService,
		@INotificationService private readonly notificationService: INotificationService,
		@ISharedProcessService private readonly sharedProcessService: ISharedProcessService,
		@IUserDataProfileService private readonly userDataProfileService: IUserDataProfileService,
		@IUserDataProfilesService private readonly userDataProfilesService: IUserDataProfilesService,
	) {
		super();

		const configured = (this.productService as unknown as Record<string, unknown>)['codexSideloadExtensions'];
		if (!Array.isArray(configured) || configured.length === 0) {
			if (this.userDataProfileService.currentProfile.isDefault) {
				this.logService.info(`${TAG} No sideload extensions configured in product.json`);
			}
			return;
		}

		const entries = parseSideloadEntries(configured);
		if (entries.length === 0) {
			return;
		}

		// Migration runs in every window (including conductor profiles).
		// Idempotent — clears `isApplicationScoped` from sideloaded extensions
		// in the Default profile, which is the legacy-data source that breaks
		// pinned-VSIX installs. See top-of-file comment for the full story.
		this.migrateLegacyAppScope(entries).catch(err => {
			this.logService.warn(`${TAG} Migration of legacy app-scope failed`, err);
		});

		// Sideload installs only run in the default profile. All sideload
		// installs target the global extension location, which the conductor's
		// `backfillCoreExtensions` later copies into each pin profile.
		if (!this.userDataProfileService.currentProfile.isDefault) {
			return;
		}

		this.ensureExtensions(entries).catch(err => {
			this.logService.error(`${TAG} Unhandled error during sideload`, err);
		});
	}

	private async migrateLegacyAppScope(entries: SideloadEntry[]): Promise<void> {
		const defaultLoc = this.userDataProfilesService.defaultProfile.extensionsResource;
		const installed = await this.extensionManagementService.getInstalled(ExtensionType.User, defaultLoc);

		const sideloadIds = new Set<string>();
		for (const entry of entries) {
			sideloadIds.add((typeof entry === 'string' ? entry : entry.id).toLowerCase());
		}

		for (const ext of installed) {
			if (!sideloadIds.has(ext.identifier.id.toLowerCase())) {
				continue;
			}
			if (!ext.isApplicationScoped) {
				continue;
			}
			// Defensive: if the manifest itself is application-scoped (a real
			// language pack), leave it alone. We only clear the flag we set
			// ourselves on extensions whose manifests don't require it.
			if (ext.manifest.contributes?.localizations?.length) {
				continue;
			}

			try {
				// IWorkbenchExtensionManagementService.updateMetadata routes to
				// the default profile automatically because ext.isApplicationScoped
				// is currently true (see extensionManagementService.ts:287).
				await this.extensionManagementService.updateMetadata(ext, { isApplicationScoped: false });
				this.logService.info(`${TAG} Migrated legacy app-scope on "${ext.identifier.id}"`);
			} catch (err) {
				this.logService.warn(`${TAG} Failed to migrate app-scope on "${ext.identifier.id}"`, err);
			}
		}
	}

	private async ensureExtensions(entries: SideloadEntry[]): Promise<void> {
		const installed = await this.extensionManagementService.getInstalled(ExtensionType.User);

		const missingGallery: string[] = [];
		const missingVsix: SideloadVsixEntry[] = [];

		for (const entry of entries) {
			if (typeof entry === 'string') {
				// Gallery entry: skip if ID is present (any version).
				// `migrateLegacyAppScope` handles the legacy isApplicationScoped
				// flag separately, so we don't need to reinstall just for that.
				const found = installed.some(e => e.identifier.id.toLowerCase() === entry.toLowerCase());
				if (!found) {
					missingGallery.push(entry);
				}
			} else {
				// VSIX entry: skip only if ID AND version match.
				const installedExt = installed.find(e => e.identifier.id.toLowerCase() === entry.id.toLowerCase());
				if (!installedExt || installedExt.manifest.version !== entry.version) {
					missingVsix.push(entry);
				}
			}
		}

		if (missingGallery.length === 0 && missingVsix.length === 0) {
			this.logService.info(`${TAG} All sideload extensions already installed`);
			return;
		}

		await Promise.all([
			this.installFromGallery(missingGallery),
			this.installFromVsix(missingVsix),
		]);
	}

	private async installFromGallery(ids: string[]): Promise<void> {
		if (ids.length === 0) {
			return;
		}

		this.logService.info(`${TAG} Installing ${ids.length} extension(s) from gallery: ${ids.join(', ')}`);

		if (!this.extensionGalleryService.isEnabled()) {
			this.logService.warn(`${TAG} Extension gallery is not available — skipping gallery installs`);
			return;
		}

		const galleryExtensions = await this.extensionGalleryService.getExtensions(
			ids.map(id => ({ id })),
			CancellationToken.None
		);

		const resolved = new Map(galleryExtensions.map(ext => [ext.identifier.id.toLowerCase(), ext]));

		for (const id of ids) {
			const galleryExt = resolved.get(id.toLowerCase());
			if (!galleryExt) {
				this.logService.warn(`${TAG} Extension "${id}" not found in gallery — skipping`);
				continue;
			}

			try {
				// `isApplicationScoped: false` is explicit (not omitted) because
				// the upstream install task inherits this flag from any existing
				// installation of the same extension — see the patched line at
				// extensionManagementService.ts:1047 (`??` semantics). Passing
				// `false` ensures legacy app-scoped installs migrate to
				// non-app-scoped on reinstall.
				await this.extensionManagementService.installFromGallery(galleryExt, {
					isApplicationScoped: false,
					isMachineScoped: true,
				});
				this.logService.info(`${TAG} Installed "${id}" v${galleryExt.version}`);
			} catch (err) {
				this.logService.error(`${TAG} Failed to install "${id}"`, err);
				this.notificationService.notify({
					severity: Severity.Warning,
					message: `Codex: Failed to install extension "${id}". It may be installed manually from the Extensions view.`,
				});
			}
		}
	}

	private async installFromVsix(entries: SideloadVsixEntry[]): Promise<void> {
		if (entries.length === 0) {
			return;
		}

		this.logService.info(`${TAG} Installing ${entries.length} extension(s) from VSIX: ${entries.map(e => e.id).join(', ')}`);

		// Use the shared process 'extensions' IPC channel to download via
		// Node.js networking, bypassing renderer CORS restrictions on redirects.
		const channel = this.sharedProcessService.getChannel('extensions');

		for (const entry of entries) {
			try {
				// See the comment in installFromGallery for why
				// `isApplicationScoped: false` is explicit.
				await channel.call('install', [URI.parse(entry.vsix), {
					installGivenVersion: true,
					pinned: true,
					isApplicationScoped: false,
					isMachineScoped: true,
					profileLocation: this.userDataProfilesService.defaultProfile.extensionsResource,
				}]);
				this.logService.info(`${TAG} Installed "${entry.id}" from VSIX ${entry.vsix}`);
			} catch (err) {
				this.logService.error(`${TAG} Failed to install "${entry.id}" from VSIX ${entry.vsix}`, err);
				this.notificationService.notify({
					severity: Severity.Warning,
					message: `Codex: Failed to install extension "${entry.id}" from VSIX. It may be installed manually from the Extensions view.`,
				});
			}
		}
	}
}
