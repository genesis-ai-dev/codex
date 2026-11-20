// Windows process-boundary test. The submitting host stands in for Codex, and the
// embedded recorder stands in for Inno. Neither writes to an installation folder.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Threading;

internal static class UpdateChainTests {
    private static int Main(string[] args) {
        string fixture = Environment.GetEnvironmentVariable("CODEX_UPDATE_FIXTURE");
        string arch = Environment.GetEnvironmentVariable("CODEX_UPDATE_ARCH");
        var installs = new List<Setup.Installation> {
            new Setup.Installation { Id = "user", Root = Path.Combine(fixture, "Utilisateur 日本語") },
            new Setup.Installation { Id = "system", Machine = true,
                Root = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Codex") }
        };
        var settings = new Dictionary<string, string> {
            { "arch", arch }, { "win32" + arch + "UserAppId", "{user" }, { "win32" + arch + "AppId", "{system" }
        };
        return Setup.UpdateInstalled(args, Assembly.GetExecutingAssembly(), installs, settings);
    }
}

internal static class RecordSetup {
    private static int Main(string[] args) {
        string fixture = Environment.GetEnvironmentVariable("CODEX_UPDATE_FIXTURE");
        string scope = Assembly.GetExecutingAssembly().GetName().Name;
        string record = Path.Combine(fixture, scope + ".txt");
        File.WriteAllLines(record, args);
        string update = args.SingleOrDefault(a => a.StartsWith("/update="));
        if (update != null) {
            if (!File.Exists(update.Substring(8))) return 2;
            // Signal readiness only after arguments have crossed both process boundaries.
            using (var ready = new Mutex(false, Environment.GetEnvironmentVariable("CODEX_UPDATE_READY"))) {
                for (int i = 0; i < 300 && File.Exists(update.Substring(8)); i++) Thread.Sleep(100);
                if (File.Exists(update.Substring(8))) return 3;
            }
        }
        return 0;
    }
}
