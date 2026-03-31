/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frontier R&D Ltd. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { localize, localize2 } from '../../../../nls.js';
import { IQuickInputService, IQuickPickItem, IQuickPickSeparator } from '../../../../platform/quickinput/common/quickInput.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService, WorkbenchState } from '../../../../platform/workspace/common/workspace.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IProgressService, ProgressLocation } from '../../../../platform/progress/common/progress.js';
import { asJson, IRequestService } from '../../../../platform/request/common/request.js';
import { URI } from '../../../../base/common/uri.js';
import { joinPath } from '../../../../base/common/resources.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { ProjectMetadata } from './codexTypes.js';

interface GitHubRelease {
	assets?: Array<{
		name: string;
		browser_download_url: string;
	}>;
}

interface PinActionItem extends IQuickPickItem {
	action: 'add' | 'remove' | 'sync' | 'info';
	extensionId?: string;
}

/** Services needed by pin management sub-flows. */
interface PinManagerContext {
	readonly quickInputService: IQuickInputService;
	readonly fileService: IFileService;
	readonly notificationService: INotificationService;
	readonly logService: ILogService;
	readonly sharedProcessService: ISharedProcessService;
	readonly requestService: IRequestService;
	readonly dialogService: IDialogService;
	readonly progressService: IProgressService;
	readonly metadataUri: URI;
}

const RELEASE_PAGE_PATTERN = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/releases\/tag\/(.+)$/;

/** JSON indentation used by codex-editor for metadata.json. */
const METADATA_INDENT = 4;

/**
 * Resolves a GitHub release page URL to a direct VSIX download URL.
 * If the URL is not a release page, returns it unchanged.
 */
async function resolveVsixUrl(requestService: IRequestService, url: string, logService: ILogService): Promise<string> {
	const match = RELEASE_PAGE_PATTERN.exec(url.trim());
	if (!match) {
		return url.trim();
	}

	const [, owner, repo, tag] = match;
	const apiUrl = `https://api.github.com/repos/${owner}/${repo}/releases/tags/${encodeURIComponent(tag)}`;

	logService.info(`[CodexPinManager] Resolving release page: ${apiUrl}`);

	const context = await requestService.request(
		{ type: 'GET', url: apiUrl, headers: { 'Accept': 'application/vnd.github+json', 'User-Agent': 'codex-pin-manager' } },
		CancellationToken.None
	);
	const release = await asJson<GitHubRelease>(context);
	if (!release?.assets) {
		throw new Error(localize('managePins.noAssets', 'No assets found in GitHub release "{0}"', tag));
	}

	const vsixAsset = release.assets.find(a => a.name.endsWith('.vsix'));
	if (!vsixAsset) {
		throw new Error(localize('managePins.noVsix', 'No .vsix asset found in GitHub release "{0}"', tag));
	}

	logService.info(`[CodexPinManager] Resolved to: ${vsixAsset.browser_download_url}`);
	return vsixAsset.browser_download_url;
}

function truncateUrl(url: string): string {
	try {
		const parsed = new URL(url);
		const segments = parsed.pathname.split('/').filter(Boolean);
		if (segments.length > 3) {
			const first2 = segments.slice(0, 2).join('/');
			const last = segments[segments.length - 1];
			return `${parsed.origin}/${first2}/.../${last}`;
		}
		return url;
	} catch {
		return url;
	}
}

registerAction2(class ManageExtensionPinsAction extends Action2 {
	constructor() {
		super({
			id: 'codex.conductor.managePins',
			title: localize2('managePins', 'Manage Extension Pins'),
			category: localize2('codex', 'Codex'),
			f1: true,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const ctx: PinManagerContext = {
			quickInputService: accessor.get(IQuickInputService),
			fileService: accessor.get(IFileService),
			notificationService: accessor.get(INotificationService),
			logService: accessor.get(ILogService),
			sharedProcessService: accessor.get(ISharedProcessService),
			requestService: accessor.get(IRequestService),
			dialogService: accessor.get(IDialogService),
			progressService: accessor.get(IProgressService),
			metadataUri: undefined!,
		};

		const workspaceService = accessor.get(IWorkspaceContextService);
		const commandService = accessor.get(ICommandService);

		if (workspaceService.getWorkbenchState() !== WorkbenchState.FOLDER) {
			ctx.notificationService.info(localize('managePins.noFolder', 'Open a project folder to manage extension pins.'));
			return;
		}

		const workspaceFolder = workspaceService.getWorkspace().folders[0];
		(ctx as { metadataUri: URI }).metadataUri = joinPath(workspaceFolder.uri, 'metadata.json');

		// Hub loop — re-opens after each action until dismissed
		while (true) {
			const metadata = await readMetadata(ctx);
			if (!metadata) {
				ctx.notificationService.info(localize('managePins.noMetadata', 'Could not read metadata.json from the workspace.'));
				return;
			}

			const action = await showHub(ctx.quickInputService, metadata);
			if (!action) {
				return; // User dismissed
			}

			switch (action.action) {
				case 'add':
					await addPin(ctx);
					break;
				case 'remove':
					await removePin(ctx, metadata);
					break;
				case 'sync':
					await syncChanges(commandService, ctx.notificationService, ctx.logService);
					break; // Continue loop — re-read and show hub with post-sync state
				case 'info':
					break; // Re-show hub
			}
		}
	}
});

async function readMetadata(ctx: PinManagerContext): Promise<ProjectMetadata | undefined> {
	try {
		const content = await ctx.fileService.readFile(ctx.metadataUri);
		return JSON.parse(content.value.toString()) as ProjectMetadata;
	} catch {
		return undefined;
	}
}

async function writeMetadata(ctx: PinManagerContext, updater: (metadata: ProjectMetadata) => void): Promise<void> {
	const content = await ctx.fileService.readFile(ctx.metadataUri);
	const metadata = JSON.parse(content.value.toString()) as ProjectMetadata;

	if (!metadata.meta) {
		metadata.meta = {};
	}
	if (!metadata.meta.pinnedExtensions) {
		metadata.meta.pinnedExtensions = {};
	}

	updater(metadata);

	const updated = JSON.stringify(metadata, null, METADATA_INDENT) + '\n';
	await ctx.fileService.writeFile(ctx.metadataUri, VSBuffer.fromString(updated));
}

function showHub(quickInputService: IQuickInputService, metadata: ProjectMetadata): Promise<PinActionItem | undefined> {
	return new Promise<PinActionItem | undefined>((resolve) => {
		const disposables = new DisposableStore();
		const picker = quickInputService.createQuickPick<PinActionItem>({ useSeparators: true });
		disposables.add(picker);

		picker.title = localize('managePins.title', 'Manage Extension Pins');
		picker.placeholder = localize('managePins.placeholder', 'Select an action');
		picker.matchOnDescription = true;
		picker.matchOnDetail = true;

		const items: (PinActionItem | IQuickPickSeparator)[] = [];

		// Required Extensions section
		const required = metadata.meta?.requiredExtensions;
		if (required) {
			const entries: [string, string][] = [];
			if (required.codexEditor) { entries.push(['codexEditor', required.codexEditor]); }
			if (required.frontierAuthentication) { entries.push(['frontierAuthentication', required.frontierAuthentication]); }

			if (entries.length > 0) {
				items.push({ type: 'separator', label: localize('managePins.required', 'Required Extensions') });
				entries.sort(([a], [b]) => a.localeCompare(b));
				for (const [id, version] of entries) {
					items.push({
						label: `$(lock) ${id}`,
						description: version,
						action: 'info',
					});
				}
			}
		}

		// Pinned Extensions section
		const pinned = metadata.meta?.pinnedExtensions;
		if (pinned && Object.keys(pinned).length > 0) {
			items.push({ type: 'separator', label: localize('managePins.pinned', 'Pinned Extensions') });
			const sortedIds = Object.keys(pinned).sort();
			for (const id of sortedIds) {
				const pin = pinned[id];
				items.push({
					label: `$(pinned) ${id}`,
					description: `v${pin.version}`,
					detail: truncateUrl(pin.url),
					action: 'info',
					extensionId: id,
				});
			}
		}

		// Actions section
		items.push({ type: 'separator', label: localize('managePins.actions', 'Actions') });
		items.push({ label: localize('managePins.addAction', '$(add) Pin an Extension...'), action: 'add' });
		if (pinned && Object.keys(pinned).length > 0) {
			items.push({ label: localize('managePins.removeAction', '$(trash) Remove a Pin...'), action: 'remove' });
		}
		items.push({ label: localize('managePins.syncAction', '$(sync) Sync Changes'), action: 'sync' });

		picker.items = items;

		let result: PinActionItem | undefined;

		disposables.add(picker.onDidAccept(() => {
			const selected = picker.selectedItems[0];
			if (!selected || selected.action === 'info') {
				return; // Keep picker open for non-actionable items
			}
			result = selected;
			picker.hide();
		}));

		disposables.add(picker.onDidHide(() => {
			disposables.dispose();
			resolve(result);
		}));

		picker.show();
	});
}

async function addPin(ctx: PinManagerContext): Promise<void> {
	// Step 1: Get URL from user
	const url = await ctx.quickInputService.input({
		title: localize('managePins.addTitle', 'Pin an Extension'),
		placeHolder: localize('managePins.addPlaceholder', 'https://github.com/.../releases/tag/0.24.1 or direct .vsix URL'),
		prompt: localize('managePins.addPrompt', 'Enter a GitHub release page URL or direct VSIX download URL'),
	});

	if (!url) {
		return;
	}

	// Step 2: Resolve URL (release page → VSIX download URL) and extract manifest
	let extensionId: string;
	let version: string;
	let resolvedUrl: string;

	try {
		const result = await ctx.progressService.withProgress(
			{ location: ProgressLocation.Notification, title: localize('managePins.inspecting', 'Inspecting VSIX...') },
			async () => {
				const resolved = await resolveVsixUrl(ctx.requestService, url, ctx.logService);
				const channel = ctx.sharedProcessService.getChannel('extensions');
				const manifest: { publisher?: string; name?: string; version?: string } =
					await channel.call('getManifest', [URI.parse(resolved)]);
				return { resolved, manifest };
			}
		);

		resolvedUrl = result.resolved;
		const manifest = result.manifest;

		if (!manifest.publisher || !manifest.name || !manifest.version) {
			ctx.notificationService.error(localize('managePins.badVsix', 'VSIX is missing publisher, name, or version in package.json.'));
			return;
		}

		extensionId = `${manifest.publisher}.${manifest.name}`;
		version = manifest.version;
	} catch (e: unknown) {
		const msg = e instanceof Error ? e.message : String(e);
		ctx.notificationService.error(localize('managePins.inspectFailed', 'Failed to inspect VSIX: {0}', msg));
		return;
	}

	// Step 3: Confirm
	const { confirmed } = await ctx.dialogService.confirm({
		message: localize('managePins.confirmPin', 'Pin {0} at v{1}?', extensionId, version),
		detail: localize('managePins.confirmPinDetail', 'This will pin {0} to version {1} for this project.', extensionId, version),
	});

	if (!confirmed) {
		return;
	}

	// Step 4: Write to metadata.json
	try {
		await writeMetadata(ctx, (m) => {
			m.meta!.pinnedExtensions![extensionId] = { version, url: resolvedUrl };
		});
		ctx.logService.info(`[CodexPinManager] Pinned ${extensionId} to v${version}`);
		ctx.notificationService.info(localize('managePins.pinned', 'Pinned {0} to v{1}.', extensionId, version));
	} catch (e: unknown) {
		const msg = e instanceof Error ? e.message : String(e);
		ctx.notificationService.error(localize('managePins.writeFailed', 'Failed to update metadata.json: {0}', msg));
	}
}

async function removePin(ctx: PinManagerContext, metadata: ProjectMetadata): Promise<void> {
	const pinned = metadata.meta?.pinnedExtensions;
	if (!pinned || Object.keys(pinned).length === 0) {
		ctx.notificationService.info(localize('managePins.noPins', 'No pinned extensions to remove.'));
		return;
	}

	// Step 1: Pick which pin to remove
	const items: (IQuickPickItem & { extensionId: string })[] = Object.keys(pinned).sort().map(id => ({
		label: id,
		description: `v${pinned[id].version}`,
		extensionId: id,
	}));

	const selected = await ctx.quickInputService.pick(items, {
		title: localize('managePins.removeTitle', 'Remove a Pin'),
		placeHolder: localize('managePins.removePlaceholder', 'Select a pinned extension to remove'),
	});

	if (!selected) {
		return;
	}

	const extensionId = (selected as typeof items[0]).extensionId;

	// Step 2: Confirm
	const { confirmed } = await ctx.dialogService.confirm({
		message: localize('managePins.confirmRemove', 'Remove pin for {0}?', extensionId),
		detail: localize('managePins.confirmRemoveDetail', 'This will unpin {0} from v{1}.', extensionId, pinned[extensionId].version),
	});

	if (!confirmed) {
		return;
	}

	// Step 3: Update metadata.json
	try {
		await writeMetadata(ctx, (m) => {
			delete m.meta!.pinnedExtensions![extensionId];
		});
		ctx.logService.info(`[CodexPinManager] Removed pin for ${extensionId}`);
		ctx.notificationService.info(localize('managePins.removed', 'Removed pin for {0}.', extensionId));
	} catch (e: unknown) {
		const msg = e instanceof Error ? e.message : String(e);
		ctx.notificationService.error(localize('managePins.writeFailed', 'Failed to update metadata.json: {0}', msg));
	}
}

async function syncChanges(
	commandService: ICommandService,
	notificationService: INotificationService,
	logService: ILogService,
): Promise<void> {
	try {
		logService.info('[CodexPinManager] Triggering Frontier sync...');
		await commandService.executeCommand('frontier.syncChanges');
		logService.info('[CodexPinManager] Frontier sync completed');
	} catch (e: unknown) {
		const msg = e instanceof Error ? e.message : String(e);
		logService.warn(`[CodexPinManager] Failed to trigger Frontier sync: ${msg}`);
		notificationService.info(localize('managePins.syncFallback', 'Sync manually to share pin changes with your team.'));
	}
}
