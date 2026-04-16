/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

use crate::{
	commands::args::{PinAddArgs, PinArgs, PinRemoveArgs, PinSubcommand},
	log,
	util::errors::{wrap, AnyError, PinningError},
};
use serde::{Deserialize, Serialize};
use std::{
	fs,
	io::Read,
	path::{Path, PathBuf},
	process::Command,
};

use super::context::CommandContext;

const CODEX_PROJECTS_DIR: &str = ".codex-projects";

#[derive(Serialize, Deserialize, Debug, Clone)]
struct ProjectMetadata {
	#[serde(rename = "projectName", default)]
	project_name: String,
	#[serde(rename = "projectId", default)]
	project_id: String,
	#[serde(default)]
	meta: Meta,
	#[serde(flatten)]
	extra: serde_json::Value,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
struct Meta {
	#[serde(rename = "requiredExtensions", default)]
	required_extensions: std::collections::HashMap<String, String>,
	#[serde(rename = "pinnedExtensions", default)]
	pinned_extensions: std::collections::HashMap<String, PinnedExtension>,
	#[serde(flatten)]
	extra: serde_json::Value,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
struct PinnedExtension {
	version: String,
	url: String,
}

struct ProjectInfo {
	path: PathBuf,
	metadata: ProjectMetadata,
}

pub async fn pin(ctx: CommandContext, args: PinArgs) -> Result<i32, AnyError> {
	match (&args.project, &args.subcommand) {
		(None, _) | (Some(_), Some(PinSubcommand::List)) | (Some(_), None) => {
			let project_filter = if let Some(p) = &args.project {
				Some(resolve_project(&ctx, p)?)
			} else {
				None
			};
			list_pins(&ctx, project_filter)?;
		}
		(Some(p), Some(PinSubcommand::Add(add_args))) => add_pin(ctx, p.clone(), add_args.clone()).await?,
		(Some(p), Some(PinSubcommand::Remove(remove_args))) => remove_pin(ctx, p.clone(), remove_args.clone())?,
		(Some(p), Some(PinSubcommand::Reset)) => reset_pin(ctx, p.clone())?,
		(Some(p), Some(PinSubcommand::Sync)) => sync_pin(ctx, p.clone()).await?,
	}

	Ok(0)
}

fn discover_projects(ctx: &CommandContext) -> Result<Vec<ProjectInfo>, AnyError> {
	// Use LauncherPaths root to find home directory reliably
	let home_dir = ctx.paths.root().parent()
		.and_then(|p| p.parent())
		.map(|p| p.to_path_buf())
		.or_else(dirs::home_dir)
		.ok_or_else(|| AnyError::PinningError(PinningError("Could not find home directory".to_string())))?;
	
	let projects_dir = home_dir.join(CODEX_PROJECTS_DIR);

	let mut projects = Vec::new();

	if projects_dir.exists() && projects_dir.is_dir() {
		for entry in fs::read_dir(projects_dir).map_err(|e| wrap(e, "Failed to read projects directory"))? {
			let entry = entry.map_err(|e| wrap(e, "Failed to read directory entry"))?;
			let path = entry.path();

			if path.is_dir() {
				let metadata_path = path.join("metadata.json");
				if metadata_path.exists() {
					match read_metadata(&metadata_path) {
						Ok(metadata) => projects.push(ProjectInfo { path, metadata }),
						Err(e) => {
							log::emit(log::Level::Warn, "pin", &format!("Failed to read metadata at {}: {}", metadata_path.display(), e));
						}
					}
				}
			}
		}
	}

	Ok(projects)
}

fn read_metadata(path: &Path) -> Result<ProjectMetadata, AnyError> {
	let file = fs::File::open(path).map_err(|e| wrap(e, "Failed to open metadata.json"))?;
	let metadata: ProjectMetadata = serde_json::from_reader(file).map_err(|e| wrap(e, "Failed to parse metadata.json"))?;
	Ok(metadata)
}

fn write_metadata(path: &Path, metadata: &ProjectMetadata) -> Result<(), AnyError> {
	let file = fs::File::create(path).map_err(|e| wrap(e, "Failed to create metadata.json"))?;
	let formatter = serde_json::ser::PrettyFormatter::with_indent(b"    ");
	let mut ser = serde_json::Serializer::with_formatter(file, formatter);
	metadata.serialize(&mut ser).map_err(|e| wrap(e, "Failed to write metadata.json"))?;
	Ok(())
}

fn truncate_url(url: &str) -> String {
	if let Ok(parsed_url) = url::Url::parse(url) {
		let mut segments = parsed_url.path_segments().map(|c| c.collect::<Vec<_>>()).unwrap_or_default();
		if segments.len() > 3 {
			let filename = segments.pop().unwrap_or("");
			let first_two = segments.iter().take(2).copied().collect::<Vec<_>>().join("/");
			format!("{}://{}/{}/.../{}", parsed_url.scheme(), parsed_url.host_str().unwrap_or(""), first_two, filename)
		} else {
			url.to_string()
		}
	} else {
		url.to_string()
	}
}

fn has_git() -> bool {
	Command::new("git").arg("--version").output().is_ok()
}

fn is_metadata_dirty(project_path: &Path) -> bool {
	Command::new("git")
		.arg("status")
		.arg("--porcelain")
		.arg("metadata.json")
		.current_dir(project_path)
		.output()
		.map(|o| !o.stdout.is_empty())
		.unwrap_or(false)
}

fn list_pins(ctx: &CommandContext, project_filter: Option<ProjectInfo>) -> Result<(), AnyError> {
	let projects = if let Some(p) = project_filter {
		vec![p]
	} else {
		discover_projects(ctx)?
	};

	let git_available = has_git();
	if !git_available {
		println!("Warning: 'git' not found in PATH. Skipping dirty checks.");
	}

	for project in projects {
		println!(
			"{} {} {}",
			project.metadata.project_name,
			project.metadata.project_id,
			project.path.display()
		);

		if !project.metadata.meta.required_extensions.is_empty() {
			let mut reqs = String::new();
			let mut ids: Vec<_> = project.metadata.meta.required_extensions.keys().collect();
			ids.sort();
			for id in ids {
				let version = &project.metadata.meta.required_extensions[id];
				reqs.push_str(&format!("⚓ {} {} ", id, version));
			}
			println!("  {}", reqs.trim_end());
		}

		let mut pinned_ids: Vec<_> = project.metadata.meta.pinned_extensions.keys().collect();
		pinned_ids.sort();
		for id in pinned_ids {
			let pin = &project.metadata.meta.pinned_extensions[id];
			println!("  📌 {} {} {}", id, pin.version, pin.url);
		}

		if git_available && is_metadata_dirty(&project.path) {
			println!("  📤 metadata.json has changes, please sync or reset: codex-cli pin {} sync", project.metadata.project_id);
		}
		println!();
	}

	println!("Usage:");
	println!("  codex pin                         List all projects and pins");
	println!("  codex pin <project>               List pins for a project");
	println!("  codex pin <project> add <url>     Add a version pin");
	println!("  codex pin <project> remove <id>   Remove a version pin");
	println!("  codex pin <project> reset         Undo metadata.json changes");
	println!("  codex pin <project> sync          Sync pin changes with remote");

	Ok(())
}

fn resolve_project(ctx: &CommandContext, project_identifier: &str) -> Result<ProjectInfo, AnyError> {
	let projects = discover_projects(ctx)?;
	let mut matches: Vec<ProjectInfo> = projects
		.into_iter()
		.filter(|p| p.metadata.project_id == project_identifier || p.metadata.project_name == project_identifier)
		.collect();

	if matches.is_empty() {
		return Err(AnyError::PinningError(PinningError(format!("No project found matching '{}'", project_identifier))));
	} else if matches.len() > 1 {
		let mut msg = format!("Multiple projects found matching '{}'. Please use the ID:\n", project_identifier);
		for m in matches {
			msg.push_str(&format!("- {} ({})\n", m.metadata.project_name, m.metadata.project_id));
		}
		return Err(AnyError::PinningError(PinningError(msg)));
	}

	Ok(matches.remove(0))
}

/// Resolves a GitHub release page URL to a direct VSIX download URL.
/// If the URL is already a direct URL (not a release page), returns it unchanged.
///
/// Matches: https://github.com/{owner}/{repo}/releases/tag/{tag}
async fn resolve_vsix_url(client: &reqwest::Client, url: &str) -> Result<String, AnyError> {
	let url = url.trim();
	const PREFIX: &str = "https://github.com/";
	const RELEASES_TAG: &str = "/releases/tag/";

	if !url.starts_with(PREFIX) {
		return Ok(url.to_string());
	}

	let after_host = &url[PREFIX.len()..];
	let tag_pos = match after_host.find(RELEASES_TAG) {
		Some(pos) => pos,
		None => return Ok(url.to_string()),
	};

	let owner_repo = &after_host[..tag_pos];
	let tag = &after_host[tag_pos + RELEASES_TAG.len()..];

	if owner_repo.is_empty() || tag.is_empty() || owner_repo.matches('/').count() != 1 {
		return Ok(url.to_string());
	}

	// Percent-encode characters that are unsafe in URL path segments.
	// Tags are typically semver (0.24.1-pr123) so only + is a realistic risk.
	let encoded_tag = tag.replace('%', "%25").replace(' ', "%20").replace('+', "%2B");
	let api_url = format!("https://api.github.com/repos/{}/releases/tags/{}", owner_repo, encoded_tag);
	log::emit(log::Level::Info, "pin", &format!("Resolving release page: {}", api_url));

	let resp = client
		.get(&api_url)
		.header("Accept", "application/vnd.github+json")
		.header("User-Agent", "codex-cli")
		.send()
		.await
		.map_err(|e| wrap(e, "Failed to query GitHub API"))?
		.error_for_status()
		.map_err(|e| wrap(e, "GitHub API returned an error"))?;

	let release: serde_json::Value = resp.json().await.map_err(|e| wrap(e, "Failed to parse GitHub API response"))?;

	let assets = release["assets"]
		.as_array()
		.ok_or_else(|| AnyError::PinningError(PinningError("No assets found in GitHub release".to_string())))?;

	let vsix_asset = assets
		.iter()
		.find(|a| a["name"].as_str().map_or(false, |n| n.ends_with(".vsix")))
		.ok_or_else(|| AnyError::PinningError(PinningError("No .vsix asset found in GitHub release".to_string())))?;

	let download_url = vsix_asset["browser_download_url"]
		.as_str()
		.ok_or_else(|| AnyError::PinningError(PinningError("Missing download URL for .vsix asset".to_string())))?;

	log::emit(log::Level::Info, "pin", &format!("Resolved to: {}", download_url));
	Ok(download_url.to_string())
}

async fn add_pin(ctx: CommandContext, project_id: String, args: PinAddArgs) -> Result<(), AnyError> {
	let mut project_info = resolve_project(&ctx, &project_id)?;

	// Resolve release page URLs to direct VSIX download URLs
	let resolved_url = resolve_vsix_url(&ctx.http, &args.url).await?;

	log::emit(log::Level::Info, "pin", &format!("Inspecting VSIX at {}...", truncate_url(&resolved_url)));

	// Optimized VSIX metadata extraction using Range requests
	let (extension_id, version) = match get_vsix_metadata_smart(&ctx.http, &resolved_url).await {
		Ok(meta) => meta,
		Err(e) => {
			log::emit(log::Level::Warn, "pin", &format!("Range request optimization not available, using full download: {}", e));
			get_vsix_metadata_full(&ctx.http, &resolved_url).await?
		}
	};

	log::emit(log::Level::Info, "pin", &format!("✔ Identified: {} (v{})", extension_id, version));

	// Update metadata
	project_info.metadata.meta.pinned_extensions.insert(
		extension_id.clone(),
		PinnedExtension {
			version: version.to_string(),
			url: resolved_url,
		},
	);

	let metadata_path = project_info.path.join("metadata.json");
	write_metadata(&metadata_path, &project_info.metadata)?;

	log::emit(log::Level::Info, "pin", &format!("✔ Updated metadata.json for \"{}\"", project_info.metadata.project_name));
	println!("Pinned {} to {}", extension_id, version);

	Ok(())
}

async fn get_vsix_metadata_smart(client: &reqwest::Client, url: &str) -> Result<(String, String), AnyError> {
	// 1. Get content length
	let head = client.head(url).send().await?.error_for_status()?;
	let content_length = head.headers()
		.get(reqwest::header::CONTENT_LENGTH)
		.and_then(|v| v.to_str().ok())
		.and_then(|s| s.parse::<u64>().ok())
		.ok_or_else(|| AnyError::PinningError(PinningError("Missing Content-Length header".to_string())))?;

	// 2. Fetch the last 16KB (contains the central directory index)
	let range_size = 16 * 1024;
	let start = if content_length > range_size { content_length - range_size } else { 0 };
	let _res = client.get(url)
		.header(reqwest::header::RANGE, format!("bytes={}-{}", start, content_length - 1))
		.send().await?.error_for_status()?;
	
	// Implementation of Range-based parsing would go here.
	// For now, we return an error to trigger the full download fallback.
	Err(AnyError::PinningError(PinningError("Range request optimization not fully implemented yet".to_string())))
}

async fn get_vsix_metadata_full(client: &reqwest::Client, url: &str) -> Result<(String, String), AnyError> {
	let response = client.get(url).send().await?.error_for_status()?;
	let bytes = response.bytes().await?;

	let reader = std::io::Cursor::new(bytes);
	let mut zip = zip::ZipArchive::new(reader).map_err(|e| wrap(e, "Failed to read VSIX as ZIP"))?;

	let mut package_json_bytes = Vec::new();
	let mut found = false;

	for i in 0..zip.len() {
		let mut file = zip.by_index(i).map_err(|e| wrap(e, "Failed to read file from ZIP"))?;
		if file.name() == "extension/package.json" {
			file.read_to_end(&mut package_json_bytes).map_err(|e| wrap(e, "Failed to read package.json from ZIP"))?;
			found = true;
			break;
		}
	}

	if !found {
		return Err(AnyError::PinningError(PinningError("Could not find extension/package.json in VSIX".to_string())));
	}

	let package_json: serde_json::Value = serde_json::from_slice(&package_json_bytes).map_err(|e| wrap(e, "Failed to parse package.json"))?;

	let publisher = package_json["publisher"]
		.as_str()
		.ok_or_else(|| AnyError::PinningError(PinningError("Missing publisher in package.json".to_string())))?;
	let name = package_json["name"]
		.as_str()
		.ok_or_else(|| AnyError::PinningError(PinningError("Missing name in package.json".to_string())))?;
	let version = package_json["version"]
		.as_str()
		.ok_or_else(|| AnyError::PinningError(PinningError("Missing version in package.json".to_string())))?;

	Ok((format!("{}.{}", publisher, name), version.to_string()))
}

fn remove_pin(ctx: CommandContext, project_id: String, args: PinRemoveArgs) -> Result<(), AnyError> {
	let mut project_info = resolve_project(&ctx, &project_id)?;

	if project_info.metadata.meta.pinned_extensions.remove(&args.id).is_some() {
		let metadata_path = project_info.path.join("metadata.json");
		write_metadata(&metadata_path, &project_info.metadata)?;
		log::emit(log::Level::Info, "pin", &format!("✔ Removed pin for {}", args.id));
	} else {
		log::emit(log::Level::Warn, "pin", &format!("No pin found for {} in project {}", args.id, project_info.metadata.project_name));
	}

	Ok(())
}

fn reset_pin(ctx: CommandContext, project_id: String) -> Result<(), AnyError> {
	if !has_git() {
		return Err(AnyError::PinningError(PinningError("'git' not found in PATH".to_string())));
	}

	let project_info = resolve_project(&ctx, &project_id)?;

	log::emit(log::Level::Info, "pin", &format!("Resetting metadata.json for {}...", project_info.metadata.project_name));

	let status = Command::new("git")
		.arg("checkout")
		.arg("--")
		.arg("metadata.json")
		.current_dir(&project_info.path)
		.status()
		.map_err(|e| wrap(e, "Failed to execute git checkout"))?;

	if !status.success() {
		return Err(AnyError::PinningError(PinningError(format!("git checkout failed with exit code {}", status.code().unwrap_or(-1)))));
	}

	log::emit(log::Level::Info, "pin", "✔ Reset successful");
	Ok(())
}

async fn sync_pin(ctx: CommandContext, project_id: String) -> Result<(), AnyError> {
	if !has_git() {
		return Err(AnyError::PinningError(PinningError("'git' not found in PATH".to_string())));
	}

	let project_info = resolve_project(&ctx, &project_id)?;

	if is_metadata_dirty(&project_info.path) {
		log::emit(log::Level::Info, "pin", &format!("Syncing changes for {}...", project_info.metadata.project_name));

		// git add metadata.json
		let status = Command::new("git")
			.arg("add")
			.arg("metadata.json")
			.current_dir(&project_info.path)
			.status()
			.map_err(|e| wrap(e, "Failed to execute git add"))?;
		if !status.success() {
			return Err(AnyError::PinningError(PinningError("git add failed".to_string())));
		}

		// git commit -m "Update extension pins"
		let status = Command::new("git")
			.arg("commit")
			.arg("-m")
			.arg("Update extension pins")
			.current_dir(&project_info.path)
			.status()
			.map_err(|e| wrap(e, "Failed to execute git commit"))?;
		if !status.success() {
			return Err(AnyError::PinningError(PinningError("git commit failed".to_string())));
		}

		// git pull --rebase
		let status = Command::new("git")
			.arg("pull")
			.arg("--rebase")
			.current_dir(&project_info.path)
			.status()
			.map_err(|e| wrap(e, "Failed to execute git pull"))?;
		if !status.success() {
			return Err(AnyError::PinningError(PinningError("git pull --rebase failed".to_string())));
		}

		// git push
		let status = Command::new("git")
			.arg("push")
			.current_dir(&project_info.path)
			.status()
			.map_err(|e| wrap(e, "Failed to execute git push"))?;
		if !status.success() {
			return Err(AnyError::PinningError(PinningError("git push failed".to_string())));
		}

		log::emit(log::Level::Info, "pin", "✔ Sync successful");
	} else {
		log::emit(log::Level::Info, "pin", &format!("No local changes to sync for {}. Fetching remote updates...", project_info.metadata.project_name));

		// git pull --rebase
		let status = Command::new("git")
			.arg("pull")
			.arg("--rebase")
			.current_dir(&project_info.path)
			.status()
			.map_err(|e| wrap(e, "Failed to execute git pull"))?;
		if !status.success() {
			return Err(AnyError::PinningError(PinningError("git pull --rebase failed".to_string())));
		}

		log::emit(log::Level::Info, "pin", "✔ Sync successful");
	}

	Ok(())
}
