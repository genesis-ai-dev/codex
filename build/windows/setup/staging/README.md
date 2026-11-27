# Windows update staging

Use a disposable Windows x64 VM snapshot and a normal Windows login. This test installs real released applications, modifies the test installations' update URL, and writes settings inside the test account. Revert the snapshot afterward.

The harness uses three existing release versions. It verifies GitHub's published SHA-256 digests and builds two combined launchers from the PR and the original scoped payloads. The server binds to loopback and serves only the two test feed routes and their EXEs. No test version or package is uploaded.

From the binary repository, in PowerShell:

```powershell
$stage = "$env:LOCALAPPDATA\CodexStagingFeed"
./build/windows/setup/staging/prepare.ps1 $stage
python ./build/windows/setup/staging/serve.py $stage
```

In a second normal PowerShell session:

```powershell
$env:CODEX_DISPOSABLE_UPDATE_TEST = '1'
./build/windows/setup/staging/client.ps1 -Directory "$env:LOCALAPPDATA\CodexStagingFeed" -Scope system -Manual
```

Choose `user` or `system` for the copy being exercised. System setup and redirecting its test feed require administrator approval. The driver checks the installed scope and version after each upgrade. In manual mode, use the running app's Manage menu to check, apply, and restart. During the first system update, decline the update's elevation prompt, reopen the original app if it exited, verify its version, then retry and approve. Distinguish the update prompt from setup's initial installation and the feed-redirection prompt. Confirm shortcuts, settings, extensions and a test project survive both updates. Test again from a fresh snapshot with the other scope already installed and verify that copy stays at its original version.

The hosted test exercises the user installation under a standard test account with a genuine system installation present. Interactive elevation on the Windows secure desktop needs separate VM testing.
