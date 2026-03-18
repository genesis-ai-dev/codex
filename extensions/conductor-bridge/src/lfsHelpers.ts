/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frontier R&D Ltd. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

export interface LFSPointer {
	oid: string;
	size: number;
}

const LFS_SIGNATURE = 'version https://git-lfs.github.com/spec/v1';

export async function isPointerFile(uri: vscode.Uri): Promise<boolean> {
	try {
		const stat = await vscode.workspace.fs.stat(uri);
		if (stat.size > 400) {
			return false;
		}
		const content = await vscode.workspace.fs.readFile(uri);
		return Buffer.from(content).toString('utf-8').includes(LFS_SIGNATURE);
	} catch {
		return false;
	}
}

export async function parsePointerFile(uri: vscode.Uri): Promise<LFSPointer | null> {
	try {
		const content = await vscode.workspace.fs.readFile(uri);
		const text = Buffer.from(content).toString('utf-8');

		if (!text.includes(LFS_SIGNATURE)) {
			return null;
		}

		const oidMatch = text.match(/oid sha256:([a-f0-9]{64})/i);
		const sizeMatch = text.match(/size (\d+)/);
		if (!oidMatch || !sizeMatch) {
			return null;
		}

		return {
			oid: oidMatch[1],
			size: parseInt(sizeMatch[1], 10),
		};
	} catch {
		return null;
	}
}
