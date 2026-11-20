using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;

internal static class SetupTests {
    private static void Reject(Action action) {
        try { action(); } catch (IOException) { return; }
        throw new Exception("Expected installer to reject an unsafe plan.");
    }

    private static int Main() {
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
