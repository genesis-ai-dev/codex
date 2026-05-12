/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frontier R&D Ltd. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export interface PinnedExtensionEntry {
	version: string;
	url: string;
}

export type PinnedExtensions = Record<string, PinnedExtensionEntry>;
export interface RequiredExtensions {
	codexEditor?: string;
	frontierAuthentication?: string;
}

export interface ProjectMetadata {
	meta?: {
		pinnedExtensions?: PinnedExtensions;
		requiredExtensions?: RequiredExtensions;
	};
	[key: string]: unknown;
}

/**
 * Validates and extracts well-formed pinned extension entries from an unknown
 * parsed JSON value. Returns only entries where the value has string `version`
 * and `url` fields. Malformed entries are silently dropped.
 */
export function parsePinnedExtensions(value: unknown): PinnedExtensions | undefined {
	if (!value || typeof value !== 'object') {
		return undefined;
	}
	const result: PinnedExtensions = {};
	for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
		if (
			entry && typeof entry === 'object' &&
			typeof (entry as Record<string, unknown>).version === 'string' &&
			typeof (entry as Record<string, unknown>).url === 'string'
		) {
			result[key] = entry as PinnedExtensionEntry;
		}
	}
	return Object.keys(result).length > 0 ? result : undefined;
}

/** A string means "install from gallery by ID". An object with `vsix` means "install directly from URL". */
export interface SideloadVsixEntry {
	id: string;
	vsix: string;
	version: string;
}

export type SideloadEntry = string | SideloadVsixEntry;

export function parseSideloadEntries(raw: unknown[]): SideloadEntry[] {
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
