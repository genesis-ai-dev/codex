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

const TAG = '[CodexSideloader]';

/** A string means "install from gallery by ID". An object with `vsix` means "install directly from URL". */
interface SideloadVsixEntry {
	id: string;
	vsix: string;
	version: string;
}

type SideloadEntry = string | SideloadVsixEntry;

function parseSideloadEntries(raw: unknown[]): SideloadEntry[] {
	const entries: SideloadEntry[] = [];
	for (const item of raw) {
		if (typeof item === 'string') {
			entries.push(item);
		} else if (
			item && typeof item === 'object' &&
			typeof (item as Record<string, unknown>).id === 'string' &&
			typeof (item as Record<string, unknown>).vsix === 'string' &&
			typeof (item as Record<string, unknown>).version === 'string'
		) {
			entries.push(item as SideloadVsixEntry);
		}
	}
	return entries;
}

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

		// Only run sideload in the default profile. All sideload installs
		// target the global extension location (defaultProfile.extensionsResource),
		// which is visible in all profiles, so there is no benefit to running
		// again in a pin-profile window.
		if (!this.userDataProfileService.currentProfile.isDefault) {
			return;
		}

		const configured = (this.productService as unknown as Record<string, unknown>)['codexSideloadExtensions'];
		if (!Array.isArray(configured) || configured.length === 0) {
			this.logService.info(`${TAG} No sideload extensions configured in product.json`);
			return;
		}

		const entries = parseSideloadEntries(configured);
		if (entries.length === 0) {
			return;
		}

		this.ensureExtensions(entries).catch(err => {
			this.logService.error(`${TAG} Unhandled error during sideload`, err);
		});
	}

	private async ensureExtensions(entries: SideloadEntry[]): Promise<void> {
		const installed = await this.extensionManagementService.getInstalled(ExtensionType.User);

		const missingGallery: string[] = [];
		const missingVsix: SideloadVsixEntry[] = [];

		for (const entry of entries) {
			if (typeof entry === 'string') {
				// Gallery entry: skip if ID is present (any version)
				const found = installed.some(e => e.identifier.id.toLowerCase() === entry.toLowerCase());
				if (!found) {
					missingGallery.push(entry);
				}
			} else {
				// VSIX entry: skip only if ID AND version match
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
				await this.extensionManagementService.installFromGallery(galleryExt, { isMachineScoped: true });
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
				await channel.call('install', [URI.parse(entry.vsix), {
					installGivenVersion: true,
					pinned: true,
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
