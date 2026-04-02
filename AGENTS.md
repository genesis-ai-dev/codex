# Codex Development Guide

This repository builds **Codex**, a freely-licensed VS Code distribution for scripture translation. It is a fork of [VSCodium](https://github.com/VSCodium/vscodium) with custom branding, patches, and bundled extensions. The build clones Microsoft's VS Code, applies patches and source overlays, bundles extensions, and compiles platform-specific binaries.

## Upstream Relationship

```
Microsoft/vscode (source code)
        ↓ (cloned at specific commit)
VSCodium/vscodium (origin) ──patches──→ VSCodium binaries
        ↓ (forked)
This repo (Codex) ──patches──→ Codex binaries
```

**Remotes:**
- `origin` = VSCodium/vscodium (upstream we sync from)
- `nexus` = BiblioNexus-Foundation/codex (our main repo)

## Repository Structure

```
patches/              # Patch files applied to vscode source (alphabetical order)
  *.patch             # Core patches applied to all builds
  insider/            # Insider-only patches
  osx/ linux/ windows/# Platform-specific patches
  user/               # Optional user patches (hide-activity-bar, microphone, etc.)
src/stable/           # Source overlay — copied into vscode/ before patches
  cli/src/commands/   # Rust CLI additions (e.g. pin.rs)
  src/vs/workbench/contrib/  # Workbench contributions (e.g. codexConductor/)
  resources/          # Branding assets (icons, desktop files)
extensions/           # Built-in extensions compiled with the VS Code build
bundle-extensions.json# Extensions downloaded from GitHub Releases during build
dev/                  # Development helper scripts
vscode/               # Cloned vscode repo (gitignored, generated during build)
```

## Building

### Local Development Build

```bash
./dev/build.sh
```

This runs the full pipeline: clone vscode → copy source overlays → apply patches → `npm ci` → compile → bundle extensions → produce platform binary.

**Flags:**
- `-s` — Skip source clone (reuse existing `vscode/`). Patches and overlays are still re-applied.
- `-o` — Prep source only, skip compilation.
- `-l` — Use latest VS Code version from Microsoft's update API.
- `-i` — Build insider variant.
- `-p` — Include asset packaging (installers).

Flags combine: `./dev/build.sh -sl` skips clone and uses latest.

### Build Pipeline

```
dev/build.sh
  ├─ get_repo.sh               # Clone vscode at commit from upstream/stable.json
  ├─ version.sh                # Compute release version (e.g. 1.108.12007)
  ├─ prepare_vscode.sh         # Copy src/stable/* overlay, merge product.json,
  │                            # apply patches/*.patch, run npm ci
  ├─ build.sh                  # gulp compile, webpack extensions, minify,
  │  ├─ get-extensions.sh      # Download VSIXs from bundle-extensions.json
  │  └─ gulp vscode-{platform}-{arch}-min-ci
  └─ prepare_assets.sh         # Create installers (only with -p flag)
```

### What Gets Modified vs What's New

There are two ways to add Codex-specific code to the VS Code source:

- **Source overlays** (`src/stable/`): For **new files**. Copied verbatim into `vscode/` before patches run. Use for new workbench contributions, new Rust CLI modules, new resources.
- **Patches** (`patches/`): For **modifying existing VS Code files**. Small, surgical diffs. Use for adding imports, registering contributions, changing config values.

### Extension Bundling

Extensions reach the final build three ways:

| Method | Config | When |
|--------|--------|------|
| **Built-in** (compiled from source) | `vscode/extensions/` | Compiled by gulp during build |
| **Downloaded** (pre-built VSIX) | `bundle-extensions.json` | Downloaded from GitHub Releases by `get-extensions.sh` |
| **Sideloaded** (runtime install) | `product.json` `codexSideloadExtensions` | Installed on first launch by `CodexSideloader` shell contribution (from gallery or direct VSIX URL) |

### Output

| Platform | Output |
|----------|--------|
| macOS | `VSCode-darwin-{arch}/Codex.app` |
| Linux | `VSCode-linux-{arch}/` |
| Windows | `VSCode-win32-{arch}/` |

On macOS: `open VSCode-darwin-arm64/Codex.app`

## Working with Patches

### Key Rules

1. **Never edit patch files by hand.** Always generate them with `git diff --staged` inside `vscode/`. Hand-written patches fail with "corrupt patch" errors.
2. **Patches are applied alphabetically.** A patch can depend on patches that sort before it (e.g. `feat-cli-pinning.patch` depends on `binary-name.patch`).
3. **Patches use placeholder variables** (`!!APP_NAME!!`, `!!BINARY_NAME!!`, `!!GH_REPO_PATH!!`, etc.) that are substituted during application.
4. **New files go in the source overlay**, not in patches. Only use patches to modify existing VS Code files.

### Creating or Updating a Patch

Use `dev/patch.sh` to ensure the correct baseline:

```bash
# Edit feat-cli-pinning.patch, which depends on binary-name.patch:
./dev/patch.sh binary-name feat-cli-pinning

# The script:
# 1. Resets vscode/ to pristine upstream
# 2. Applies binary-name.patch as the baseline
# 3. Applies feat-cli-pinning.patch (with --reject if it partially fails)
# 4. Waits for you to make changes in vscode/
# 5. Press any key → regenerates the patch from git diff --staged -U1
```

The last argument is the patch being edited. All preceding arguments are prerequisites that form the baseline. **Always list all patches your target depends on.**

### Manual Patch Workflow

If `dev/patch.sh` isn't suitable (e.g. non-interactive environment):

```bash
cd vscode
git reset --hard HEAD          # Clean state

# Apply prerequisites
git apply --ignore-whitespace ../patches/binary-name.patch
git add . && git commit --no-verify -q -m "baseline"

# Make your changes to existing VS Code files
# ...

# Generate the patch
git add .
git diff --staged -U1 > ../patches/my-feature.patch
```

### Validating Patches

```bash
# Test all patches apply cleanly in sequence:
./dev/update_patches.sh

# Or manually test one:
cd vscode
git apply --check ../patches/my-feature.patch
```

### Patch Dependencies

Some Codex patches modify files that earlier patches also touch. When this happens, the later patch must be generated against a tree that includes the earlier patch. Current known dependencies:

| Patch | Depends on |
|-------|-----------|
| `feat-cli-pinning.patch` | `binary-name.patch` (both modify `nativeHostMainService.ts`) |

If a patch fails to apply with "patch does not apply", check whether a prerequisite patch changed the same file. Regenerate using `dev/patch.sh` with the prerequisite listed first.

## Codex-Specific Components

### CodexConductor (Workbench Contribution)

**Location:** `src/stable/src/vs/workbench/contrib/codexConductor/`
**Patch:** `patches/feat-codex-conductor.patch` (adds the import to `workbench.common.main.ts`)
**Robustness Patch:** `patches/zzz-authoritative-reload.patch` (enables `forceProfile` in window reloads)

Enforces project-scoped extension version pins. Reads `pinnedExtensions` from project `metadata.json` or Frontier's `workspaceState`, downloads VSIXs from GitHub Release URLs, installs into deterministic VS Code profiles, and switches the extension host.

**Key Robustness Features:**
- **Authoritative Reload:** Uses a patched `reload({ forceProfile: name })` IPC command to ensure the Main process opens the new window in the correct profile, bypassing persistence race conditions and dev-mode restrictions.
- **Initialization Yielding:** Works in tandem with `codex-editor` which returns early from `activate()` if a mismatch is detected, showing a "pins applying" message on the splash screen.
- **Duplicate Prevention:** Explicitly calls `resetWorkspaces()` before associating a profile to ensure lookup consistency.
- **Loop Guard:** Includes a 3-cycle circuit breaker to prevent infinite reload loops if enforcement fails.
- **Lifecycle Management:** Automatic cleanup of orphaned profiles every 14 days.

### CodexSideloader (Workbench Contribution)

**Location:** `src/stable/src/vs/workbench/contrib/codexSideloader/`
**Patch:** `patches/feat-codex-sideloader.patch` (adds import to `workbench.common.main.ts`, depends on `feat-codex-conductor.patch`)

Ensures global extensions are installed on first launch. Reads the `codexSideloadExtensions` array from `product.json`. Entries can be a string (gallery install from Open VSX) or an object with `id` + `vsix` fields (direct VSIX install via shared process IPC, bypassing the marketplace). Replaces the standalone `extension-sideloader` extension.

### CLI Pin Commands (Rust)

**Overlay:** `src/stable/cli/src/commands/pin.rs`
**Patch:** `patches/feat-cli-pinning.patch` (registers the `pin` subcommand in args/argv, adds `PinningError`, refactors macOS shell command install for `codex-cli` symlink)

Adds `codex pin list/add/remove` to the Rust CLI. The `add` command downloads a remote VSIX, extracts the extension ID and version, and writes the pin to `metadata.json`.

### Extension Bundling

**Config:** `bundle-extensions.json`
**Script:** `get-extensions.sh`

Declarative JSON config for extensions downloaded as pre-built VSIXs from GitHub Releases during the build.

## Key Scripts

| Script | Purpose |
|--------|---------|
| `dev/build.sh` | Local development build (main entry point) |
| `dev/patch.sh` | Apply prerequisite patches + edit a target patch |
| `dev/update_patches.sh` | Validate/fix all patches sequentially |
| `dev/clean_codex.sh` | Remove all Codex app data from macOS (reset to clean state) |
| `get_repo.sh` | Clone vscode at the commit specified in `upstream/stable.json` |
| `prepare_vscode.sh` | Copy overlays, merge product.json, apply patches, npm ci |
| `build.sh` | Compile (gulp), bundle extensions, produce platform binary |
| `get-extensions.sh` | Download VSIXs listed in `bundle-extensions.json` |

## Version Tracking

The target VS Code version is in `upstream/stable.json`:

```json
{
  "tag": "1.108.1",
  "commit": "585eba7c0c34fd6b30faac7c62a42050bfbc0086"
}
```

The Codex release version appends a time-based patch number: `{tag}.{day*24+hour}` (e.g. `1.108.12007`).

## Syncing with Upstream VSCodium

### Codex-Specific Customizations to Preserve

1. **Branding** — `src/stable/`, `src/insider/`, `icons/`
2. **GitHub Workflows** — Simplified vs VSCodium. Custom: `docker-build-push.yml`, `patch-rebuild.yml`, `manual-release.yml`
3. **Windows MSI** — `build/windows/msi/codex.*` (renamed from `vscodium.*`)
4. **Product config** — `prepare_vscode.sh` (URLs, app names)
5. **Custom patches** — `patches/feat-*` (Codex features), `patches/user/*` (microphone, UI tweaks)
6. **Windows code signing** — SSL.com eSigner in `stable-windows.yml`
7. **Extension bundling** — `bundle-extensions.json`, `get-extensions.sh`
8. **Workbench contributions** — `src/stable/src/vs/workbench/contrib/codexConductor/`
9. **Rust CLI additions** — `src/stable/cli/src/commands/pin.rs`

### Merge Strategy

For small gaps: `git merge origin/master`, resolve conflicts.
For large gaps: cherry-pick patch updates from upstream, re-apply Codex customizations.
After merging: `./dev/update_patches.sh` then `./dev/build.sh` to validate.
