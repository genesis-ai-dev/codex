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
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { ExtensionType } from '../../../../platform/extensions/common/extensions.js';

const TAG = '[CodexSideloader]';

export class CodexSideloaderContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.codexSideloader';

	constructor(
		@IWorkbenchExtensionManagementService private readonly extensionManagementService: IWorkbenchExtensionManagementService,
		@IExtensionGalleryService private readonly extensionGalleryService: IExtensionGalleryService,
		@IProductService private readonly productService: IProductService,
		@ILogService private readonly logService: ILogService,
		@INotificationService private readonly notificationService: INotificationService,
	) {
		super();

		const configured = (this.productService as Record<string, unknown>)['codexSideloadExtensions'];
		if (!Array.isArray(configured) || configured.length === 0) {
			this.logService.info(`${TAG} No sideload extensions configured in product.json`);
			return;
		}

		const extensionIds: string[] = configured.filter((id): id is string => typeof id === 'string');
		if (extensionIds.length === 0) {
			return;
		}

		this.ensureExtensions(extensionIds).catch(err => {
			this.logService.error(`${TAG} Unhandled error during sideload`, err);
		});
	}

	private async ensureExtensions(extensionIds: string[]): Promise<void> {
		// Determine which extensions are already installed
		const installed = await this.extensionManagementService.getInstalled(ExtensionType.User);
		const installedIds = new Set(installed.map(e => e.identifier.id.toLowerCase()));

		const missing = extensionIds.filter(id => !installedIds.has(id.toLowerCase()));
		if (missing.length === 0) {
			this.logService.info(`${TAG} All sideload extensions already installed`);
			return;
		}

		this.logService.info(`${TAG} Installing ${missing.length} missing extension(s): ${missing.join(', ')}`);

		// Check if gallery service is available
		if (!this.extensionGalleryService.isEnabled()) {
			this.logService.warn(`${TAG} Extension gallery is not available — skipping sideload`);
			return;
		}

		// Resolve extension IDs to gallery entries
		const galleryExtensions = await this.extensionGalleryService.getExtensions(
			missing.map(id => ({ id })),
			CancellationToken.None
		);

		const resolved = new Map(galleryExtensions.map(ext => [ext.identifier.id.toLowerCase(), ext]));

		for (const id of missing) {
			const galleryExt = resolved.get(id.toLowerCase());
			if (!galleryExt) {
				this.logService.warn(`${TAG} Extension "${id}" not found in gallery — skipping`);
				continue;
			}

			try {
				await this.extensionManagementService.installFromGallery(galleryExt);
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
}
