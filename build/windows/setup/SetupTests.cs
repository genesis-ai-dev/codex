using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;

internal static class SetupTests {
    [System.Runtime.InteropServices.DllImport("user32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode)]
    private static extern IntPtr FindWindow(string klass, string title);
    [System.Runtime.InteropServices.DllImport("user32.dll")]
    private static extern bool PostMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
    [System.Runtime.InteropServices.DllImport("user32.dll")]
    private static extern bool PrintWindow(IntPtr window, IntPtr dc, uint flags);
    [System.Runtime.InteropServices.DllImport("user32.dll")]
    private static extern bool GetWindowRect(IntPtr window, out Bounds rect);
    private struct Bounds { public int Left, Top, Right, Bottom; }

    private static void Reject(Action action) {
        try { action(); } catch (IOException) { return; }
        throw new Exception("Expected installer to reject an unsafe plan.");
    }

    [STAThread]
    private static int Main() {
        System.Windows.Forms.Application.EnableVisualStyles();
        var root = Directory.CreateDirectory(Path.Combine(Path.GetTempPath(), "Codex-tést 日本語 " + Guid.NewGuid())).FullName;
        try {
            var app = Directory.CreateDirectory(Path.Combine(root, "resources", "app")).FullName;
            var file = Path.Combine(app, "product.json");
            File.WriteAllText(Path.Combine(root, "Codex.exe"), "");
            File.WriteAllText(file, "{\"applicationName\":\"codex\",\"target\":\"user\",\"win32AppUserModelId\":\"OpenAI.Codex\"}");
            Reject(() => Setup.VerifyProduct(root, false));
            File.WriteAllText(file, "{\"applicationName\":\"codex\",\"target\":\"user\",\"win32AppUserModelId\":\"Codex.Codex\",\"version\":\"1\"}");
            Setup.VerifyProduct(root, false, "1");
            Reject(() => Setup.VerifyProduct(root, true));
            Reject(() => Setup.VerifyProduct(root, false, "2"));

            var registered = new List<Setup.Installation> { new Setup.Installation { Root = root, Id = "legacy" } };
            Setup.ValidatePlan(registered, "legacy", root);
            Setup.ValidatePlan(registered, "new", root + "-other");
            Reject(() => Setup.ValidatePlan(registered, "new", Path.Combine(root, "data")));
            Reject(() => Setup.ValidatePlan(new List<Setup.Installation>(), "new", root));
            Reject(() => Setup.FullDir(Path.GetPathRoot(root)));
            if (!Setup.Overlap(root.ToUpperInvariant(), root) || Setup.Overlap(root, root + "-other")) return 1;
            var user = registered[0];
            var system = new Setup.Installation { Id = "system", Machine = true,
                Root = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Codex") };
            var both = new List<Setup.Installation> { system, user };
            foreach (var inventory in new[] { new List<Setup.Installation>(), registered,
                new List<Setup.Installation> {system}, both }) {
                foreach (bool machine in new[] {false, true}) {
                    string label = Setup.ScopeLabel(inventory, machine);
                    if (label.Contains("currently installed") != inventory.Any(i => i.Machine == machine) ||
                        inventory.Where(i => i.Machine == machine).Any(i => !label.Contains(i.Root))) return 1;
                }
            }
            foreach (int button in new[] { 100, 101, 2 }) {
                using (var timer = new System.Windows.Forms.Timer { Interval = 300 }) {
                    timer.Tick += delegate {
                        var window = FindWindow("#32770", "Setup - Codex");
                        if (window == IntPtr.Zero) return;
                        string preview = Environment.GetEnvironmentVariable("CODEX_SETUP_PREVIEW");
                        if (button == 101 && preview != null) {
                            Bounds bounds;
                            GetWindowRect(window, out bounds);
                            using (var image = new System.Drawing.Bitmap(bounds.Right-bounds.Left, bounds.Bottom-bounds.Top))
                            using (var graphics = System.Drawing.Graphics.FromImage(image)) {
                                var dc = graphics.GetHdc();
                                try { PrintWindow(window, dc, 0); } finally { graphics.ReleaseHdc(dc); }
                                image.Save(preview, System.Drawing.Imaging.ImageFormat.Png);
                            }
                        }
                        PostMessage(window, 0x0466, (IntPtr)button, IntPtr.Zero); // TDM_CLICK_BUTTON
                    };
                    timer.Start();
                    if (Setup.Choose(new List<Setup.Installation> { system }) !=
                        (button == 2 ? (bool?)null : button == 101)) return 1;
                }
            }
            // A double-click must open Inno's license, tasks and ready pages with its own task defaults.
            string wizardFlags = Setup.WizardFlags(root);
            if (wizardFlags != "/SP- /CodexScopeSetup=1 /NORESTART /RESTARTEXITCODE=3010 /DIR=\"" + root + "\"") return 1;
            var cache = Path.GetTempPath();
            var userCache = Path.Combine(cache, "codex-stable-user-x64");
            var systemCache = Path.Combine(cache, "codex-stable-system-x64");
            if (Setup.UpdateTarget(both, userCache, "x64", user.Id, system.Id) != user ||
                Setup.UpdateTarget(both, systemCache, "x64", user.Id, system.Id) != system ||
                Setup.UpdateTarget(registered, root, "x64", user.Id, system.Id) != user) return 1;
            Reject(() => Setup.UpdateTarget(both, root, "x64", user.Id, system.Id));
            Reject(() => Setup.UpdateTarget(registered, systemCache, "x64", user.Id, system.Id));
            Reject(() => Setup.UpdateTarget(registered, userCache, "arm64", user.Id, system.Id));
            string package = Path.Combine(root, "CodeSetup-stable-abc.exe");
            string marker = Path.ChangeExtension(package, ".flag");
            var flags = Setup.UpdateFlags(new[] { "/verysilent", "/log", "/update=" + marker,
                "/sessionend=" + Path.Combine(root, "session-ending.flag"), "/nocloseapplications",
                "/mergetasks=runcode,!desktopicon,!quicklaunchicon" }, package, root);
            if (!flags.Contains("/update=\"" + marker + "\"") || !flags.Contains("/DIR=\"" + root + "\"") ||
                !Setup.UpdateFlags(new[] { "/silent", "/log" }, package, root).Contains("/silent")) return 1;
            Reject(() => Setup.UpdateFlags(new[] { "/silent", "/DIR=C:\\other" }, package, root));
            Reject(() => Setup.UpdateFlags(new[] { "/verysilent", "/update=invalid" }, package, root));
            var testKey = @"Software\CodexTranslationEditorTests\" + Guid.NewGuid();
            try {
                using (var hive = Microsoft.Win32.Registry.CurrentUser.CreateSubKey(testKey))
                using (var scope = hive.CreateSubKey("legacy_is1"))
                using (var other = hive.CreateSubKey("OpenAI_is1")) {
                    string uninstaller = Path.Combine(root, "unins000.exe");
                    File.WriteAllText(uninstaller, "");
                    scope.SetValue("InstallLocation", root);
                    scope.SetValue("UninstallString", "\"" + uninstaller + "\"");
                    var result = new List<Setup.Installation>();
                    Setup.ReadRegistrations(hive, false, new[] { "legacy" }, result);
                    Setup.ReadRegistrations(hive, false, new[] { "legacy" }, result);
                    if (result.Count != 1 || Setup.DefaultMachineScope(result)) return 1;
                    scope.SetValue("UninstallString", Path.Combine(root, "Codex.exe"));
                    Reject(() => Setup.ReadRegistrations(hive, false, new[] { "legacy" }, result));
                }
            } finally { Microsoft.Win32.Registry.CurrentUser.DeleteSubKeyTree(testKey); }
            var portable = Directory.CreateDirectory(Path.Combine(root, "data"));
            Reject(() => Setup.ValidatePlan(registered, "legacy", root));
            portable.Delete();
            registered[0].Machine = true;
            Reject(() => Setup.ValidatePlan(registered, "new", root + "-other"));
            Console.WriteLine("Passed product, scope, version, occupied directory, migration, locale, and overlap checks.");
            return 0;
        } finally { Directory.Delete(root, true); }
    }
}
