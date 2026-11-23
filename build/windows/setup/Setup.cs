// The launcher remains in the original user's session. Only the machine-scope
// Inno installer or its registered uninstaller may request elevation.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Win32;

internal static class Setup {
    internal sealed class Installation {
        internal string Id, Root, Uninstaller;
        internal bool Machine;
    }

    private const string Product = "Codex.Codex";
    private const string Uninstall = @"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\";
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    private static Dictionary<string, string> config;
    private const string title = "Codex Translation Editor Setup";

    [DllImport("msi.dll", CharSet = CharSet.Unicode)]
    private static extern uint MsiEnumRelatedProducts(string upgrade, uint reserved, uint index, System.Text.StringBuilder product);

    [DllImport("shell32.dll")]
    private static extern int SHGetKnownFolderPath(ref Guid id, uint flags, IntPtr token, out IntPtr path);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetLongPathName(string path, System.Text.StringBuilder buffer, uint size);

    // Node and the CLR can receive different long and DOS short spellings of TEMP.
    private static string ExistingDirectoryName(string value) {
        string path = FullDir(value);
        var buffer = new System.Text.StringBuilder(32768);
        uint length = GetLongPathName(path, buffer, (uint)buffer.Capacity);
        if (length == 0 || length >= buffer.Capacity)
            throw new IOException("Could not resolve the updater directory: " + path);
        return buffer.ToString();
    }

    private static string UserPrograms() {
        Guid id = new Guid("5CD7AEE2-2219-4A67-B85D-6C9CE15660CB");
        IntPtr path;
        Marshal.ThrowExceptionForHR(SHGetKnownFolderPath(ref id, 0, IntPtr.Zero, out path));
        try { return Marshal.PtrToStringUni(path); } finally { Marshal.FreeCoTaskMem(path); }
    }

    internal static string FullDir(string value) {
        if (String.IsNullOrWhiteSpace(value) || !System.Text.RegularExpressions.Regex.IsMatch(value, @"^[A-Za-z]:\\"))
            throw new IOException("Expected a local installation directory.");
        string path = Path.GetFullPath(value).TrimEnd('\\');
        if (path.Length < 4) throw new IOException("A drive root cannot be an installation directory.");
        for (DirectoryInfo d = new DirectoryInfo(path); d != null; d = d.Parent)
            if (((ExistingAttributes(d.FullName) ?? 0) & FileAttributes.ReparsePoint) != 0)
                throw new IOException("Installation directory uses a junction or symbolic link: " + d.FullName);
        return path;
    }

    private static FileAttributes? ExistingAttributes(string path) {
        try { return File.GetAttributes(path); }
        catch (FileNotFoundException) { return null; }
        catch (DirectoryNotFoundException) { return null; }
    }

    private static bool Equal(string a, string b) { return String.Equals(a, b, StringComparison.OrdinalIgnoreCase); }
    internal static bool Overlap(string a, string b) {
        return Equal(a,b) || a.StartsWith(b + "\\", StringComparison.OrdinalIgnoreCase) || b.StartsWith(a + "\\", StringComparison.OrdinalIgnoreCase);
    }

    private static string Field(Dictionary<string, object> data, string name) {
        object value;
        return data.TryGetValue(name, out value) ? value as string : null;
    }

    internal static void VerifyProduct(string root, bool machine, string expectedVersion = null) {
        var manifest = Json.Deserialize<Dictionary<string, object>>(File.ReadAllText(Path.Combine(root, @"resources\app\product.json")));
        if (Field(manifest, "win32AppUserModelId") != Product || Field(manifest, "applicationName") != "codex" ||
            (expectedVersion != null && Field(manifest, "version") != expectedVersion) ||
            Field(manifest, "target") != (machine ? "system" : "user") || !File.Exists(Path.Combine(root, "Codex.exe")))
            throw new IOException("Could not verify the Codex Translation Editor installation in " + root);
    }

    private static List<Installation> Inventory() {
        var found = new List<Installation>();
        foreach (bool machine in new[] { false, true }) {
            foreach (RegistryView view in Environment.Is64BitOperatingSystem ? new[] { RegistryView.Registry64, RegistryView.Registry32 } : new[] { RegistryView.Registry32 }) {
                using (var hive = RegistryKey.OpenBaseKey(machine ? RegistryHive.LocalMachine : RegistryHive.CurrentUser, view)) {
                    using (var uninstall = hive.OpenSubKey(Uninstall.TrimEnd('\\'))) {
                        if (uninstall != null) ReadRegistrations(uninstall, machine, new[] { "", "x64", "arm64" }
                            .Select(arch => config["win32" + arch + (machine ? "AppId" : "UserAppId")].Substring(1)), found);
                    }
                }
            }
        }
        return found;
    }

    internal static void ReadRegistrations(RegistryKey uninstall, bool machine, IEnumerable<string> ids, List<Installation> found) {
        foreach (string id in ids) {
            using (var key = uninstall.OpenSubKey(id + "_is1")) {
                if (key == null) continue;
                string root = FullDir(key.GetValue("InstallLocation") as string);
                VerifyProduct(root, machine);
                string exe = (key.GetValue("UninstallString") as string ?? "").Trim('"');
                if (!Equal(Path.GetDirectoryName(exe), root) ||
                    !System.Text.RegularExpressions.Regex.IsMatch(Path.GetFileName(exe), @"^unins[0-9]{3}\.exe$", System.Text.RegularExpressions.RegexOptions.IgnoreCase) ||
                    !File.Exists(exe) || (File.GetAttributes(exe) & FileAttributes.ReparsePoint) != 0)
                    throw new IOException("Unverified uninstaller in " + root);
                if (!found.Any(i => i.Id == id && Equal(i.Root, root)))
                    found.Add(new Installation { Machine = machine, Id = id, Root = root, Uninstaller = exe });
            }
        }
    }

    private static void Launch(string exe, string args, bool machine) {
        using (var p = Process.Start(new ProcessStartInfo(exe, args) { UseShellExecute = machine })) {
            p.WaitForExit();
            if (p.ExitCode != 0) throw new IOException("Setup stopped (exit " + p.ExitCode + "). Run setup again after resolving the problem.");
        }
    }

    internal static bool DefaultMachineScope(IEnumerable<Installation> installed) {
        return installed.Any(i => i.Machine);
    }

    private static void AddScope(TableLayoutPanel body, bool machine, bool selected, List<Installation> installed) {
        var paths = installed.Where(i => i.Machine == machine).Select(i => i.Root)
            .Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
        string name = machine ? "Anyone who uses this computer (all users)" : "Only for me (" + Environment.UserName + ")";
        var option = new RadioButton { Name = machine ? "allUsers" : "currentUser", AutoSize = true,
            Text = name + (paths.Length == 0 ? "" : " (currently installed)"),
            Checked = selected, UseMnemonic = false, Margin = new Padding(0, 12, 0, 2) };
        body.Controls.Add(option);
        if (paths.Length > 0) {
            body.Controls.Add(new Label { Text = String.Join(Environment.NewLine, paths), UseMnemonic = false,
                MaximumSize = new System.Drawing.Size(480, 0), AutoSize = true, Margin = new Padding(19, 0, 0, 4) });
        }
    }

    internal static Form CreateScopePage(List<Installation> installed, System.Drawing.Image logo, System.Drawing.Font heading) {
        var form = new Form { Text = "Setup - Codex", Font = System.Drawing.SystemFonts.MessageBoxFont,
            AutoScaleDimensions = new System.Drawing.SizeF(96, 96), AutoScaleMode = AutoScaleMode.Dpi,
            AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink, FormBorderStyle = FormBorderStyle.FixedDialog,
            StartPosition = FormStartPosition.CenterScreen, MaximizeBox = false, MinimizeBox = false };
        var layout = new TableLayoutPanel { AutoSize = true, ColumnCount = 1, Dock = DockStyle.Fill,
            MinimumSize = new System.Drawing.Size(580, 0), BackColor = System.Drawing.SystemColors.Window,
            ForeColor = System.Drawing.SystemColors.WindowText };
        var header = new TableLayoutPanel { AutoSize = true, ColumnCount = 2, RowCount = 2, Dock = DockStyle.Fill,
            Padding = new Padding(20, 8, 10, 8), Margin = Padding.Empty };
        header.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        header.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        header.Controls.Add(new Label { Text = "Choose Installation Options", Font = heading, AutoSize = true }, 0, 0);
        header.Controls.Add(new Label { Text = "Who should Codex Translation Editor be installed for?",
            AutoSize = true, Margin = new Padding(18, 0, 0, 0) }, 0, 1);
        var picture = new PictureBox { Image = logo, SizeMode = PictureBoxSizeMode.Zoom, Width = 48, Height = 48,
            Margin = Padding.Empty };
        header.Controls.Add(picture, 1, 0);
        header.SetRowSpan(picture, 2);
        layout.Controls.Add(header);

        var body = new TableLayoutPanel { AutoSize = true, ColumnCount = 1, Dock = DockStyle.Fill,
            BackColor = System.Drawing.SystemColors.Control, ForeColor = System.Drawing.SystemColors.ControlText,
            MinimumSize = new System.Drawing.Size(0, 280), Padding = new Padding(36, 20, 26, 18), Margin = Padding.Empty };
        layout.Controls.Add(new Panel { Height = 1, BackColor = System.Drawing.SystemColors.ControlDark,
            Dock = DockStyle.Top, Margin = Padding.Empty });
        bool machine = DefaultMachineScope(installed);
        AddScope(body, true, machine, installed);
        AddScope(body, false, !machine, installed);
        // Keep the options together at the top in a full-height wizard page.
        for (int row = 0; row < body.Controls.Count; row++) body.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        body.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        body.Controls.Add(new Label { Text = "Installing for all users requires administrator access.",
            AutoSize = true, Anchor = AnchorStyles.Bottom | AnchorStyles.Left, Margin = new Padding(0, 16, 0, 2) });
        body.RowCount = body.RowStyles.Count;
        layout.Controls.Add(body);
        layout.Controls.Add(new Panel { Height = 1, BackColor = System.Drawing.SystemColors.ControlDark,
            Dock = DockStyle.Top, Margin = Padding.Empty });
        var actions = new FlowLayoutPanel { AutoSize = true, Dock = DockStyle.Fill, Margin = Padding.Empty,
            Padding = new Padding(8), FlowDirection = FlowDirection.RightToLeft, BackColor = System.Drawing.SystemColors.Control };
        var next = new Button { Text = "Next", DialogResult = DialogResult.OK, AutoSize = true };
        var cancel = new Button { Text = "Cancel", DialogResult = DialogResult.Cancel, AutoSize = true };
        actions.Controls.Add(cancel);
        actions.Controls.Add(next);
        form.AcceptButton = next;
        form.CancelButton = cancel;
        layout.Controls.Add(actions);
        form.Controls.Add(layout);
        return form;
    }

    private static bool? Choose(List<Installation> installed) {
        using (var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("wizardLogo"))
        using (var logo = System.Drawing.Image.FromStream(stream))
        using (var heading = new System.Drawing.Font(System.Drawing.SystemFonts.MessageBoxFont, System.Drawing.FontStyle.Bold))
        using (var icon = System.Drawing.Icon.ExtractAssociatedIcon(Application.ExecutablePath))
        using (var form = CreateScopePage(installed, logo, heading)) {
            form.Icon = icon;
            return form.ShowDialog() == DialogResult.OK ?
                (bool?)((RadioButton)form.Controls.Find("allUsers", true).Single()).Checked : null;
        }
    }

    private static bool TrustedMachineRoot(string path) {
        var parents = new[] { Environment.SpecialFolder.ProgramFiles, Environment.SpecialFolder.ProgramFilesX86 }
            .Select(Environment.GetFolderPath).Where(dir => !String.IsNullOrEmpty(dir));
        return parents.Any(dir => new[] { "Codex", "Codex-arm64", "Codex-x64" }
            .Any(name => Equal(path, FullDir(Path.Combine(dir, name)))));
    }

    internal static void ValidatePlan(List<Installation> installed, string targetId, string dest) {
        foreach (var item in installed) {
            if (Directory.Exists(Path.Combine(item.Root, "data")))
                throw new IOException("This installation contains portable user data. Move that data before migrating: " + item.Root);
        }
        foreach (var old in installed.Where(i => i.Id != targetId)) {
            if (Overlap(old.Root, dest) || installed.Any(i => i != old && Overlap(i.Root, old.Root)))
                throw new IOException("Registered installation folders overlap. Setup cannot safely remove one copy: " + old.Root);
            // Only invoke a machine uninstaller from the standard protected product directory.
            if (old.Machine && !TrustedMachineRoot(old.Root))
                throw new IOException("Machine installation uses a custom directory. Remove it through Windows Installed apps first: " + old.Root);
        }
        if (!installed.Any(i => i.Id == targetId && Equal(i.Root, dest)) &&
            ExistingAttributes(dest).HasValue && Directory.EnumerateFileSystemEntries(dest).Any())
            throw new IOException("Another application or files already occupy " + dest);
    }

    // Released clients cache the downloaded EXE under codex-stable-{user|system}-{arch}.
    // Both feeds can use the same payload while the cache still identifies the requesting scope.
    internal static Installation UpdateTarget(List<Installation> installed, string packageDir, string arch,
                                               string userId, string systemId) {
        string cache = Path.GetTempPath();
        bool userCache = Equal(packageDir, Path.Combine(cache, "codex-stable-user-" + arch));
        bool systemCache = Equal(packageDir, Path.Combine(cache, "codex-stable-system-" + arch));
        if (!userCache && !systemCache && Equal(Path.GetDirectoryName(packageDir), cache.TrimEnd('\\')) &&
            Path.GetFileName(packageDir).StartsWith("codex-stable-", StringComparison.OrdinalIgnoreCase))
            throw new IOException("Updater cache architecture or scope does not match this package.");
        var matches = installed.Where(i => i.Id == (i.Machine ? systemId : userId)
            && (!userCache || !i.Machine) && (!systemCache || i.Machine)).ToList();
        if (matches.Count != 1 || (!userCache && !systemCache && installed.Count != 1))
            throw new IOException("Silent update requires one verified installation or a matching Codex updater cache.");
        var target = matches[0];
        if (target.Machine && !TrustedMachineRoot(target.Root))
            throw new IOException("Cannot silently update an unverified machine directory.");
        if (installed.Any(i => i != target && Overlap(i.Root, target.Root)) || Directory.Exists(Path.Combine(target.Root, "data")))
            throw new IOException("Silent update requires an independent installation directory without portable data.");
        return target;
    }

    internal static string UpdateFlags(string[] args, string package, string destination) {
        if (!args.Any(a => Equal(a, "/silent") || Equal(a, "/verysilent")))
            throw new IOException("Expected /silent or /verysilent.");
        var flags = new List<string>();
        var directory = Path.GetDirectoryName(package);
        foreach (var arg in args) {
            if (new[] { "/silent", "/verysilent", "/log", "/nocloseapplications",
                        "/mergetasks=runcode,!desktopicon,!quicklaunchicon" }.Contains(arg, StringComparer.OrdinalIgnoreCase)) {
                flags.Add(arg);
                continue;
            }
            string prefix, name;
            if (arg.StartsWith("/update=", StringComparison.OrdinalIgnoreCase)) {
                prefix = "/update=";
                name = Path.GetFileNameWithoutExtension(package) + ".flag";
            } else if (arg.StartsWith("/sessionend=", StringComparison.OrdinalIgnoreCase)) {
                prefix = "/sessionend=";
                name = "session-ending.flag";
            } else {
                throw new IOException("Unsupported silent update argument.");
            }
            string expected = Path.Combine(directory, name);
            string supplied = arg.Substring(prefix.Length);
            if (supplied.Length > 1 && supplied[0] == '"' && supplied[supplied.Length-1] == '"')
                supplied = supplied.Substring(1, supplied.Length-2);
            if (!Equal(Path.GetFileName(supplied), name) ||
                !Equal(ExistingDirectoryName(Path.GetDirectoryName(supplied)), ExistingDirectoryName(directory)))
                throw new IOException("Unexpected updater flag location for " + prefix + " Expected " + expected + ", received " + supplied);
            flags.Add(prefix + "\"" + expected + "\"");
        }
        flags.Add("/NORESTART");
        flags.Add("/DIR=\"" + destination + "\"");
        return String.Join(" ", flags);
    }

    internal static void WritePayload(Assembly assembly, bool machine, Stream output) {
        using (var shared = assembly.GetManifestResourceStream("user")) {
            if (!machine) {
                shared.CopyTo(output);
                return;
            }
            using (var delta = new BinaryReader(assembly.GetManifestResourceStream("systemDelta"))) {
                var buffer = new byte[65536];
                while (delta.BaseStream.Position < delta.BaseStream.Length) {
                    int offset = delta.ReadInt32();
                    int remaining = delta.ReadInt32();
                    if (remaining <= 0 || offset < -1) throw new InvalidDataException("Invalid setup payload.");
                    Stream source = offset == -1 ? delta.BaseStream : shared;
                    if (offset >= 0) shared.Position = offset;
                    while (remaining > 0) {
                        int read = source.Read(buffer, 0, Math.Min(remaining, buffer.Length));
                        if (read == 0) throw new EndOfStreamException();
                        output.Write(buffer, 0, read);
                        remaining -= read;
                    }
                }
            }
        }
    }

    private static string ExtractPayload(Assembly assembly, bool machine) {
        string path = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString("N") + ".exe");
        using (var file = new FileStream(path, FileMode.CreateNew, FileAccess.Write)) {
            try {
                WritePayload(assembly, machine, file);
            } catch {
                file.Close();
                File.Delete(path);
                throw;
            }
        }
        return path;
    }

    [STAThread]
    private static int Main(string[] args) {
        try {
            if (args.Length == 0) Application.EnableVisualStyles();
            if (new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator))
                throw new IOException("Start setup from your normal Windows session. Windows will request administrator access for an all-users installation.");
            using (var mutex = new Mutex(false, @"Global\CodexTranslationEditorScopeSetup")) {
                try { if (!mutex.WaitOne(0)) throw new IOException("Another Codex Translation Editor setup is running."); }
                catch (AbandonedMutexException) { }
                try { return Install(args); } finally { mutex.ReleaseMutex(); }
            }
        } catch (Exception e) {
            if (args.Length == 0) MessageBox.Show(e.Message, title, MessageBoxButtons.OK, MessageBoxIcon.Error);
            else {
                Console.Error.WriteLine(e.Message);
                // The updater detaches with stderr discarded. Honour its /log request.
                if (args.Contains("/log", StringComparer.OrdinalIgnoreCase)) {
                    try {
                        string log = Path.Combine(Path.GetTempPath(), "CodexUpdateError-" + Guid.NewGuid().ToString("N") + ".log");
                        using (var stream = new FileStream(log, FileMode.CreateNew, FileAccess.Write))
                        using (var writer = new StreamWriter(stream)) writer.WriteLine(e);
                    } catch (IOException) { }
                    catch (UnauthorizedAccessException) { }
                }
            }
            return 1;
        }
    }

    internal static int UpdateInstalled(string[] args, Assembly assembly, List<Installation> installed,
                                        Dictionary<string, string> settings) {
        string package = assembly.Location;
        var existing = UpdateTarget(installed, Path.GetDirectoryName(package), settings["arch"],
            settings["win32" + settings["arch"] + "UserAppId"].Substring(1),
            settings["win32" + settings["arch"] + "AppId"].Substring(1));
        var flags = UpdateFlags(args, package, existing.Root);
        string payload = ExtractPayload(assembly, existing.Machine);
        try {
            Launch(payload, flags, existing.Machine);
            return 0;
        } finally { File.Delete(payload); }
    }

    private static int Install(string[] args) {
        var assembly = Assembly.GetExecutingAssembly();
        using (var input = new StreamReader(assembly.GetManifestResourceStream("config")))
            config = Json.Deserialize<Dictionary<string,string>>(input.ReadToEnd());
        uint msi = MsiEnumRelatedProducts("{965370CD-253C-4720-82FC-2E6B02A53808}", 0, 0, new System.Text.StringBuilder(39));
        if (msi != 259) throw new IOException(msi == 0 ? "An MSI installation is registered. Update it with the MSI or remove it through Windows Installed apps before switching installer types." : "Windows Installer could not verify the installed products.");
        var installed = Inventory();
        if (args.Length != 0)
            return UpdateInstalled(args, assembly, installed, config);
        bool? choice = Choose(installed);
        if (!choice.HasValue) return 2;
        bool machine = choice.Value;
        string id = config["win32" + config["arch"] + (machine ? "AppId" : "UserAppId")].Substring(1);
        var target = installed.SingleOrDefault(i => i.Id == id);
        string dest = target != null ? target.Root : FullDir(Path.Combine(machine ? Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles) :
            UserPrograms(), "Codex"));
        // Different architecture IDs can historically share the default directory.
        // Use a distinct destination so its predecessor can remain usable until verification.
        if (target == null && installed.Any(i => Equal(i.Root, dest)))
            dest = FullDir(dest + "-" + config["arch"]);
        ValidatePlan(installed, id, dest);
        if (machine && !TrustedMachineRoot(dest)) throw new IOException("All-users setup requires a standard protected Codex program directory.");
        var obsolete = installed.Where(i => i.Id != id).ToList();
        if (obsolete.Count > 0 && MessageBox.Show("Install in " + dest + ", then uninstall these copies?\n\n" +
            String.Join("\n", obsolete.Select(i => i.Root + (i.Machine ? " (all users)" : " (current user)"))),
            title, MessageBoxButtons.OKCancel, MessageBoxIcon.Question, MessageBoxDefaultButton.Button2) != DialogResult.OK) return 2;

        string temp = ExtractPayload(assembly, machine);
        try {
            string flags = "/SP- /SILENT /NORESTART /RESTARTEXITCODE=3010 /MERGETASKS=\"!runcode,!addtopath\" /DIR=\"" + dest + "\"";
            Launch(temp, flags, machine);
            VerifyProduct(dest, machine, config["version"]);
            var refreshed = Inventory();
            if (!refreshed.Any(i => i.Id == id && Equal(i.Root, dest))) throw new IOException("New installation was not registered. Previous installations were kept.");
            foreach (var old in obsolete) {
                var registered = Inventory().SingleOrDefault(i => i.Id == old.Id && Equal(i.Root, old.Root));
                if (registered == null) continue;
                ValidatePlan(Inventory(), id, dest);
                if (!Equal(old.Uninstaller, registered.Uninstaller)) throw new IOException("Installation changed during setup.");
                Launch(registered.Uninstaller, "/SILENT /NORESTART", registered.Machine);
                if (File.Exists(Path.Combine(old.Root, "Codex.exe")))
                    throw new IOException("Windows has not removed the old program in " + old.Root +
                        ". Close running copies and check Windows Installed apps before continuing.");
            }
            if (obsolete.Any(i => i.Machine == machine)) Launch(temp, flags, machine); // Restore same-hive shortcuts and file associations.
            VerifyProduct(dest, machine, config["version"]);
            var final = Inventory();
            if (final.Count != 1 || final[0].Id != id || !Equal(final[0].Root, dest))
                throw new IOException("An additional installation is still registered. Close Codex and run setup again.");
            MessageBox.Show("Codex Translation Editor is installed in " + dest, title);
            return 0;
        } finally { if (File.Exists(temp)) File.Delete(temp); }
    }
}
