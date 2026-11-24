// The original user's Inno wizard owns every visible page. Only the fixed
// machine-scope operations below run elevated. No executable or destination
// path is accepted from a pipe client.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Linq;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Threading;
using System.Windows.Forms;

internal static partial class Setup {
    private static readonly string[] Choices = { "desktopicon", "quicklaunchicon", "addcontextmenufiles",
        "addcontextmenufolders", "associatewithfiles", "addtopath" };

    private static string PipeName(string token) {
        Guid id;
        if (!Guid.TryParseExact(token, "N", out id)) throw new IOException("Invalid setup session.");
        return "CodexSetup-" + id.ToString("N");
    }

    private static NamedPipeServerStream Server(string token, bool allowAdmins) {
        var acl = new PipeSecurity();
        acl.AddAccessRule(new PipeAccessRule(WindowsIdentity.GetCurrent().User, PipeAccessRights.FullControl, AccessControlType.Allow));
        if (allowAdmins) acl.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null),
            PipeAccessRights.FullControl, AccessControlType.Allow));
        return new NamedPipeServerStream(PipeName(token), PipeDirection.InOut, 1, PipeTransmissionMode.Byte,
            PipeOptions.Asynchronous, 4096, 4096, acl);
    }

    private static NamedPipeClientStream Connect(string token) {
        var pipe = new NamedPipeClientStream(".", PipeName(token), PipeDirection.InOut, PipeOptions.None, TokenImpersonationLevel.Identification);
        try { pipe.Connect(15000); return pipe; } catch { pipe.Dispose(); throw; }
    }

    private static bool AcceptWhileRunning(NamedPipeServerStream server, Process peer) {
        var pending = server.WaitForConnectionAsync();
        while (!pending.IsCompleted) {
            if (peer.WaitForExit(100) && !pending.IsCompleted) return false;
        }
        pending.GetAwaiter().GetResult();
        return true;
    }

    internal static string PreviousTasks(List<Installation> inventory, bool machine, string id) {
        var source = inventory.OrderByDescending(i => i.Id == id)
            .ThenByDescending(i => i.Machine == machine).FirstOrDefault();
        if (source == null) return "";
        var selected = (source.SelectedTasks ?? "").Split(',');
        var deselected = (source.DeselectedTasks ?? "").Split(',');
        var tasks = new List<string>();
        foreach (string name in Choices) {
            if (selected.Contains(name, StringComparer.OrdinalIgnoreCase)) tasks.Add(name);
            else if (deselected.Contains(name, StringComparer.OrdinalIgnoreCase)) tasks.Add("!" + name);
        }
        return String.Join(",", tasks);
    }

    private static string TaskArgs(string selected) {
        var names = selected.Split(new[] { ',' }, StringSplitOptions.RemoveEmptyEntries);
        if (names.Any(n => !Choices.Contains(n))) throw new IOException("Unrecognized setup task.");
        // Explicit negatives also preserve an intentionally empty selection.
        return " /MERGETASKS=\"" + String.Join(",", Choices.Select(n => names.Contains(n) ? n : "!" + n)) + ",!runcode\"";
    }

    private static void InstallScope(bool machine, string tasks) {
        var inventory = Inventory(machine);
        var dest = Destination(inventory, machine);
        ValidatePlan(inventory, ScopeId(machine), dest);
        if (machine && !TrustedMachineRoot(dest)) throw new IOException("Unverified machine destination.");
        var flags = WizardFlags(dest) + " /VERYSILENT" + TaskArgs(tasks);
        // Use Program Files for elevated extraction. A standard user must not
        // be able to replace the executable between reconstruction and launch.
        string temp = Path.Combine(machine ? Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles) :
            Path.GetTempPath(), Guid.NewGuid().ToString("N") + ".exe");
        using (var file = new FileStream(temp, FileMode.CreateNew, FileAccess.Write)) {
            try { WritePayload(Assembly.GetExecutingAssembly(), machine, file); }
            catch { file.Close(); File.Delete(temp); throw; }
        }
        try { Launch(temp, flags, false); } finally { File.Delete(temp); }
        VerifyProduct(dest, machine, config["version"]);
        if (!Inventory(machine).Any(i => i.Id == ScopeId(machine) && Equal(i.Root, dest)))
            throw new IOException("New installation was not registered. Previous copies were kept.");
    }

    // Inno may return before its temporary helper deletes the registered
    // uninstaller. An immediate scope switch would see an occupied directory.
    private static void WaitForUninstallerRemoval(Installation old) {
        var elapsed = Stopwatch.StartNew();
        while (ExistingAttributes(old.Uninstaller).HasValue) {
            if (elapsed.Elapsed >= TimeSpan.FromSeconds(15))
                throw new IOException("Windows has not finished removing " + old.Uninstaller + ". Retry cleanup.");
            Thread.Sleep(100);
        }
    }

    private static void RemoveOld(Installation old) {
        var item = Inventory(old.Machine).SingleOrDefault(i => i.Id == old.Id && Equal(i.Root, old.Root));
        if (item == null) {
            if (File.Exists(Path.Combine(old.Root, "Codex.exe")))
                throw new IOException("The previous copy still exists but its uninstaller is no longer registered: " + old.Root);
            WaitForUninstallerRemoval(old);
            return;
        }
        if (!Equal(item.Uninstaller, old.Uninstaller) || Directory.Exists(Path.Combine(item.Root, "data")) ||
            (item.Machine && !TrustedMachineRoot(item.Root))) throw new IOException("Installation changed during setup.");
        Launch(item.Uninstaller, "/VERYSILENT /SUPPRESSMSGBOXES /NORESTART", false);
        if (File.Exists(Path.Combine(old.Root, "Codex.exe")) || Inventory(old.Machine).Any(i => i.Id == old.Id && Equal(i.Root, old.Root)))
            throw new IOException("Previous installation still exists: " + old.Root);
        WaitForUninstallerRemoval(old);
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetNamedPipeServerProcessId(Microsoft.Win32.SafeHandles.SafePipeHandle pipe, out uint id);

    private static int MachineWork(string token, string mode) {
        if (mode != "system" && mode != "user") return 1;
        if (!new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator)) return 1;
        bool install = mode == "system";
        using (var pipe = Connect(token))
        using (var input = new BinaryReader(pipe))
        using (var output = new BinaryWriter(pipe)) {
            uint serverPid;
            if (!GetNamedPipeServerProcessId(pipe.SafePipeHandle, out serverPid)) return 1;
            using (var parent = Process.GetProcessById((int)serverPid)) {
                if (!Equal(parent.MainModule.FileName, Assembly.GetExecutingAssembly().Location)) return 1;
            }
            try {
                var before = Inventory(true);
                string dest = Destination(before, true);
                if (install) ValidatePlan(before, ScopeId(true), dest);
                var old = before.Where(i => !install || i.Id != ScopeId(true)).ToList();
                output.Write("ready"); output.Flush();
                string tasks = "";
                if (install) {
                    if (input.ReadString() != "install") return 2;
                    tasks = input.ReadString();
                    InstallScope(true, tasks);
                    output.Write("ok"); output.Flush();
                }
                while (true) {
                    if (input.ReadString() != "cleanup") return 2;
                    try {
                        foreach (var item in old) RemoveOld(item);
                        if (install && old.Count > 0) InstallScope(true, tasks);
                    } catch (Exception e) {
                        output.Write(e.Message); output.Flush();
                        continue;
                    }
                    output.Write("ok"); output.Flush();
                    break;
                }
            } catch (EndOfStreamException) { return 2; }
            catch (Exception e) { output.Write(e.Message); output.Flush(); return 1; }
        }
        return 0;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetNamedPipeClientProcessId(Microsoft.Win32.SafeHandles.SafePipeHandle pipe, out uint id);

    private sealed class Elevation : IDisposable {
        private readonly NamedPipeServerStream pipe;
        private readonly Process process;
        private readonly BinaryWriter output;
        private readonly BinaryReader input;

        internal Elevation(bool machine, IntPtr owner) {
            string token = Guid.NewGuid().ToString("N");
            pipe = Server(token, true);
            try {
                process = Process.Start(new ProcessStartInfo(Assembly.GetExecutingAssembly().Location,
                    "/machine-work " + token + (machine ? " system" : " user")) {
                    UseShellExecute = true, Verb = "runas", ErrorDialogParentHandle = owner,
                    WorkingDirectory = Environment.SystemDirectory
                });
                if (!AcceptWhileRunning(pipe, process)) throw new IOException("Administrator setup could not start.");
                uint peer;
                if (!GetNamedPipeClientProcessId(pipe.SafePipeHandle, out peer) || peer != process.Id)
                    throw new IOException("Unexpected administrator setup process.");
                input = new BinaryReader(pipe);
                output = new BinaryWriter(pipe);
                string startup = input.ReadString();
                if (startup != "ready") throw new IOException("Administrator setup could not start: " + startup);
            } catch { Dispose(); throw; }
        }

        internal void Run(string command, string tasks = null) {
            output.Write(command);
            if (tasks != null) output.Write(tasks);
            output.Flush();
            string answer = input.ReadString();
            if (answer != "ok") throw new IOException(answer);
        }

        public void Dispose() {
            pipe.Dispose();
            if (process != null) process.Dispose();
        }
    }

    private static int WizardRequest(string[] args) {
        if (args.Length != 4) return 1;
        using (var pipe = Connect(args[1]))
        using (var output = new BinaryWriter(pipe))
        using (var input = new BinaryReader(pipe)) {
            output.Write(args[2]); output.Write(args[3]); output.Flush();
            int result = input.ReadInt32();
            output.Write(true); output.Flush();
            return result;
        }
    }

    private static int Interactive(Assembly assembly, List<Installation> initial) {
        string plan = Path.GetTempFileName();
        string token = Guid.NewGuid().ToString("N");
        Elevation admin = null;
        try {
            File.WriteAllLines(plan, new[] { "[setup]", "default=" + (DefaultMachineScope(initial) ? "1" : "0"),
                "systemLabel=" + ScopeLabel(initial,true).Replace("\n"," - "), "userLabel=" + ScopeLabel(initial,false).Replace("\n"," - "),
                "userTasks=" + PreviousTasks(initial, false, ScopeId(false)),
                "systemTasks=" + PreviousTasks(initial, true, ScopeId(true)),
                "userDir=" + Destination(initial, false), "systemDir=" + Destination(initial, true),
                "launcher=" + assembly.Location, "session=" + token }, System.Text.Encoding.Unicode);
            // Seed the outer wizard with the code.iss defaults before applying the
            // chosen registration. Its own AppId can only see Current User.
            string wizard = ExtractPayload(assembly, false);
            try {
                using (var pipe = Server(token, false))
                using (var ui = Process.Start(new ProcessStartInfo(wizard, "/SP- /TASKS=associatewithfiles,addtopath /CodexPlan=\"" + plan + "\"") { UseShellExecute = false })) {
                    bool? choice = null;
                    bool complete = false, installed = false, machineClean = false;
                    string dest = null;
                    List<Installation> old = null;
                    while (AcceptWhileRunning(pipe, ui)) {
                        var input = new BinaryReader(pipe);
                        var output = new BinaryWriter(pipe);
                        string command = input.ReadString(), value = input.ReadString();
                        int code = 1;
                        try {
                            if (command == "release" && !installed) {
                                if (admin != null) { admin.Dispose(); admin = null; }
                                choice = null; code = 0;
                            } else if (command == "scope" && !installed) {
                                if (admin != null) { admin.Dispose(); admin = null; }
                                choice = null;
                                string[] scope = value.Split(',');
                                if (scope.Length != 2 || (scope[0] != "system" && scope[0] != "user")) throw new IOException("Invalid scope.");
                                bool machine = scope[0] == "system";
                                var inventory = Inventory();
                                dest = Destination(inventory, machine);
                                string id = ScopeId(machine);
                                ValidatePlan(inventory, id, dest);
                                old = inventory.Where(i => i.Id != id).ToList();
                                var review = new List<string>();
                                if (old.Count > 0) {
                                    review.Add("Install and verify the new copy in " + dest + ", then uninstall:");
                                    review.AddRange(old.Select(i => "    " + (i.Machine ? "All Users" : "Current User") + " - " + i.Root));
                                    if (!machine && old.Any(i => i.Machine))
                                        review.Add("Other Windows accounts will lose access to the All Users installation.");
                                }
                                File.WriteAllLines(plan + ".migration", review, System.Text.Encoding.UTF8);
                                if (machine || old.Any(i => i.Machine)) admin = new Elevation(machine, new IntPtr(Int64.Parse(scope[1])));
                                choice = machine;
                                code = 0;
                            } else if ((command == "install" || command == "cleanup") && choice.HasValue && !complete && installed == (command == "cleanup")) {
                                bool machine = choice.Value;
                                if (!installed) {
                                    TaskArgs(value);
                                    var inventory = Inventory();
                                    if (!Equal(dest, Destination(inventory, machine)) ||
                                        !old.Select(i => i.Uninstaller).SequenceEqual(inventory.Where(i => i.Id != ScopeId(machine)).Select(i => i.Uninstaller),
                                            StringComparer.OrdinalIgnoreCase)) throw new IOException("Installations changed. Run setup again.");
                                    ValidatePlan(inventory, ScopeId(machine), dest);
                                    if (machine) admin.Run("install", value); else InstallScope(false, value);
                                    installed = true;
                                }
                                VerifyProduct(dest, machine, config["version"]);
                                foreach (var item in old.Where(i => !i.Machine)) RemoveOld(item);
                                if (admin != null && !machineClean) { admin.Run("cleanup"); machineClean = true; }
                                if (!machine && old.Any(i => !i.Machine)) InstallScope(false, value);
                                var final = Inventory();
                                if (final.Count != 1 || final[0].Id != ScopeId(machine) || !Equal(final[0].Root, dest))
                                    throw new IOException("Installation verification failed.");
                                complete = true; code = 0;
                            } else if (command == "launch" && complete) {
                                Process.Start(new ProcessStartInfo(Path.Combine(dest, "Codex.exe")) { UseShellExecute = false });
                                code = 0;
                            }
                        } catch (Exception e) {
                            if (installed && !complete) {
                                File.WriteAllText(plan + ".cleanup", e.Message, System.Text.Encoding.UTF8);
                                code = 3;
                            } else {
                                var win = e as System.ComponentModel.Win32Exception;
                                // Windows reports 1223 for Cancel, 5 for access denied, and 1260
                                // when policy denies a standard user's elevation request.
                                if (win != null && (win.NativeErrorCode == 1223 || win.NativeErrorCode == 5 || win.NativeErrorCode == 1260)) code = 2; else MessageBox.Show(e.Message, title);
                            }
                        }
                        output.Write(code); output.Flush();
                        input.ReadBoolean(); pipe.Disconnect();
                    }
                    return complete ? 0 : 2;
                }
            } finally { File.Delete(wizard); }
        } finally { if (admin != null) admin.Dispose(); File.Delete(plan + ".cleanup"); File.Delete(plan + ".migration"); File.Delete(plan); }
    }
}
