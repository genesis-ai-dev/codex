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
    private static string title = "Codex Translation Editor Setup";

    [DllImport("msi.dll", CharSet = CharSet.Unicode)]
    private static extern uint MsiEnumRelatedProducts(string upgrade, uint reserved, uint index, System.Text.StringBuilder product);

    [DllImport("shell32.dll")]
    private static extern int SHGetKnownFolderPath(ref Guid id, uint flags, IntPtr token, out IntPtr path);

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
            if (d.Exists && (d.Attributes & FileAttributes.ReparsePoint) != 0)
                throw new IOException("Installation directory uses a junction or symbolic link: " + d.FullName);
        return path;
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

    private static bool? Choose(bool machine, List<Installation> installed) {
        using (var form = new Form { Text = title, Width = 540, Height = 260, StartPosition = FormStartPosition.CenterScreen,
                                    FormBorderStyle = FormBorderStyle.FixedDialog, MaximizeBox = false, MinimizeBox = false, AutoScaleMode = AutoScaleMode.Dpi }) {
            var panel = new FlowLayoutPanel { Dock = DockStyle.Fill, FlowDirection = FlowDirection.TopDown, WrapContents = false, Padding = new Padding(12) };
            panel.Controls.Add(new Label { AutoSize = true, Text = "Install Codex Translation Editor for" });
            var user = new RadioButton { Text = "Current user", AutoSize = true, Checked = !machine };
            var all = new RadioButton { Text = "All users on this PC", AutoSize = true, Checked = machine };
            panel.Controls.Add(user); panel.Controls.Add(all);
            panel.Controls.Add(new Label { AutoSize = true, MaximumSize = new System.Drawing.Size(480, 0),
                Text = installed.Count == 0 ? "A new installation will be created." :
                    "Existing installation folders:\n" + String.Join("\n", installed.Select(i => i.Root)) });
            var next = new Button { Text = "Continue", AutoSize = true, DialogResult = DialogResult.OK };
            panel.Controls.Add(next); form.AcceptButton = next; form.Controls.Add(panel);
            return form.ShowDialog() == DialogResult.OK ? (bool?)all.Checked : null;
        }
    }

    private static bool TrustedMachineRoot(string path) {
        return new[] { "Codex", "Codex-arm64", "Codex-x64" }.Any(name =>
            Equal(path, FullDir(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), name))));
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
            Directory.Exists(dest) && Directory.EnumerateFileSystemEntries(dest).Any())
            throw new IOException("Another application or files already occupy " + dest);
    }

    [STAThread]
    private static int Main(string[] args) {
        try {
            if (args.Length != 0) throw new IOException("For unattended deployment use the scope-specific installer.");
            if (new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator))
                throw new IOException("Start setup from your normal Windows session. Windows will request administrator access for an all-users installation.");
            using (var mutex = new Mutex(false, @"Global\CodexTranslationEditorScopeSetup")) {
                try { if (!mutex.WaitOne(0)) throw new IOException("Another Codex Translation Editor setup is running."); }
                catch (AbandonedMutexException) { }
                try { return Install(); } finally { mutex.ReleaseMutex(); }
            }
        } catch (Exception e) {
            MessageBox.Show(e.Message, title, MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }

    private static int Install() {
        var assembly = Assembly.GetExecutingAssembly();
        using (var input = new StreamReader(assembly.GetManifestResourceStream("config")))
            config = Json.Deserialize<Dictionary<string,string>>(input.ReadToEnd());
        uint msi = MsiEnumRelatedProducts("{965370CD-253C-4720-82FC-2E6B02A53808}", 0, 0, new System.Text.StringBuilder(39));
        if (msi != 259) throw new IOException(msi == 0 ? "An MSI installation is registered. Update it with the MSI or remove it through Windows Installed apps before switching installer types." : "Windows Installer could not verify the installed products.");
        var installed = Inventory();
        bool? choice = Choose(DefaultMachineScope(installed), installed);
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

        string temp = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString("N") + ".exe");
        try {
            using (var file = new FileStream(temp, FileMode.CreateNew, FileAccess.Write))
            using (var input = assembly.GetManifestResourceStream(machine ? "system" : "user")) input.CopyTo(file);
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
