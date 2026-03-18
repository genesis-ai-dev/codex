/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frontier R&D Ltd. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as path from 'path';
import { isPointerFile, parsePointerFile } from './lfsHelpers';

const FRONTIER_EXTENSION_ID = 'frontier-rnd.frontier-authentication';
const CONDUCTOR_STORAGE_PREFIX = 'codex.conductor';

interface PinnedExtensionEntry {
	version: string;
	reason: string;
	expiry?: string;
	setBy?: string;
}

type PinnedExtensions = Record<string, PinnedExtensionEntry>;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	const workspaceFolders = vscode.workspace.workspaceFolders;
	if (!workspaceFolders || workspaceFolders.length === 0) {
		return;
	}

	const workspaceUri = workspaceFolders[0].uri;

	// Resolve any LFS pointers for pinned VSIXs
	await resolveVsixPointers(workspaceUri, context);
}

export function deactivate(): void {
	// nothing to clean up
}

// ── LFS VSIX resolution ───────────────────────────────────────────

async function resolveVsixPointers(
	workspaceUri: vscode.Uri,
	context: vscode.ExtensionContext
): Promise<void> {
	const pins = await readPinnedExtensions(workspaceUri);
	const projectPath = workspaceUri.fsPath;

	for (const [id, pin] of Object.entries(pins)) {
		if (pin.expiry && new Date(pin.expiry) < new Date()) {
			continue;
		}

		const vsixFilename = `${id}-${pin.version}.vsix`;
		const vsixUri = vscode.Uri.joinPath(workspaceUri, '.project', 'extensions', vsixFilename);

		const pointer = await isPointerFile(vsixUri);
		if (!pointer) {
			continue; // Real file or doesn't exist — nothing to do
		}

		console.log(`[ConductorBridge] VSIX "${vsixFilename}" is an LFS pointer — downloading`);
		const success = await downloadVsixFromLFS(vsixUri, projectPath);
		if (success) {
			console.log(`[ConductorBridge] Downloaded "${vsixFilename}" successfully`);
			// Signal the conductor that the VSIX is now available
			await context.workspaceState.update(
				`${CONDUCTOR_STORAGE_PREFIX}.vsixReady.${id}`,
				Date.now()
			);
		} else {
			console.warn(`[ConductorBridge] Failed to download "${vsixFilename}" from LFS`);
		}
	}
}

async function downloadVsixFromLFS(
	vsixUri: vscode.Uri,
	projectPath: string
): Promise<boolean> {
	const parsed = await parsePointerFile(vsixUri);
	if (!parsed) {
		return false;
	}

	const frontierApi = await getFrontierAPI();
	if (!frontierApi?.downloadLFSFile) {
		console.warn('[ConductorBridge] Frontier API does not expose downloadLFSFile');
		return false;
	}

	try {
		const fileData: Buffer = await frontierApi.downloadLFSFile(
			projectPath,
			parsed.oid,
			parsed.size
		);
		const dir = vscode.Uri.file(path.dirname(vsixUri.fsPath));
		await vscode.workspace.fs.createDirectory(dir);
		await vscode.workspace.fs.writeFile(vsixUri, fileData);
		return true;
	} catch (error) {
		console.warn('[ConductorBridge] LFS download failed:', error);
		return false;
	}
}

// ── Frontier API access ────────────────────────────────────────────

interface FrontierAPI {
	downloadLFSFile(projectPath: string, oid: string, size: number): Promise<Buffer>;
}

async function getFrontierAPI(): Promise<FrontierAPI | null> {
	const ext = vscode.extensions.getExtension(FRONTIER_EXTENSION_ID);
	if (!ext) {
		return null;
	}
	if (!ext.isActive) {
		try {
			await ext.activate();
		} catch {
			return null;
		}
	}
	return ext.exports as FrontierAPI | null;
}

// ── Metadata helpers ───────────────────────────────────────────────

async function readPinnedExtensions(workspaceUri: vscode.Uri): Promise<PinnedExtensions> {
	try {
		const metadataUri = vscode.Uri.joinPath(workspaceUri, 'metadata.json');
		const bytes = await vscode.workspace.fs.readFile(metadataUri);
		const metadata = JSON.parse(Buffer.from(bytes).toString('utf-8'));
		return metadata?.meta?.pinnedExtensions ?? {};
	} catch {
		return {};
	}
}
