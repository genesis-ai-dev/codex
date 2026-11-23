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
            PipeAccessRights.ReadWrite, AccessControlType.Allow));
        return new NamedPipeServerStream(PipeName(token), PipeDirection.InOut, 1, PipeTransmissionMode.Byte,
            PipeOptions.Asynchronous, 4096, 4096, acl);
    }

    private static NamedPipeClientStream Connect(string token) {
        var pipe = new NamedPipeClientStream(".", PipeName(token), PipeDirection.InOut, PipeOptions.None, TokenImpersonationLevel.Identification);
        try { pipe.Connect(15000); return pipe; } catch { pipe.Dispose(); throw; }
    }

    private static bool AcceptWhileRunning(NamedPipeServerStream server, Process peer) {
        var pending = server.BeginWaitForConnection(null, null);
        using (var ready = pending.AsyncWaitHandle) {
            while (!ready.WaitOne(100)) if (peer.HasExited) return false;
        }
        server.EndWaitForConnection(pending);
        return true;
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

    private static void RemoveOld(Installation old) {
        var item = Inventory(old.Machine).SingleOrDefault(i => i.Id == old.Id && Equal(i.Root, old.Root));
        if (item == null) return;
        if (!Equal(item.Uninstaller, old.Uninstaller) || Directory.Exists(Path.Combine(item.Root, "data")) ||
            (item.Machine && !TrustedMachineRoot(item.Root))) throw new IOException("Installation changed during setup.");
        Launch(item.Uninstaller, "/SILENT /NORESTART", false);
        if (File.Exists(Path.Combine(old.Root, "Codex.exe"))) throw new IOException("Previous installation still exists: " + old.Root);
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
            var before = Inventory(true);
            string dest = Destination(before, true);
            if (install) ValidatePlan(before, ScopeId(true), dest);
            var old = before.Where(i => !install || i.Id != ScopeId(true)).ToList();
            output.Write("ready"); output.Flush();
            try {
                string tasks = "";
                if (install) {
                    if (input.ReadString() != "install") return 2;
                    tasks = input.ReadString();
                    InstallScope(true, tasks);
                    output.Write("ok"); output.Flush();
                }
                if (input.ReadString() != "cleanup") return 2;
                foreach (var item in old) RemoveOld(item);
                if (install && old.Count > 0) InstallScope(true, tasks);
                output.Write("ok"); output.Flush();
            } catch (EndOfStreamException) { return 2; }
            catch (Exception e) { output.Write(e.Message); output.Flush(); return 1; }
        }
        return 0;
    }

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
                    UseShellExecute = true, Verb = "runas", ErrorDialogParentHandle = owner
                });
                if (!AcceptWhileRunning(pipe, process)) throw new IOException("Administrator setup could not start.");
                input = new BinaryReader(pipe);
                output = new BinaryWriter(pipe);
                if (input.ReadString() != "ready") throw new IOException("Administrator setup was not ready.");
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
                "launcher=" + assembly.Location, "session=" + token }, System.Text.Encoding.Unicode);
            string wizard = ExtractPayload(assembly, false);
            try {
                using (var pipe = Server(token, false))
                using (var ui = Process.Start(new ProcessStartInfo(wizard, "/SP- /CodexPlan=\"" + plan + "\"") { UseShellExecute = false })) {
                    bool? choice = null;
                    bool complete = false;
                    string dest = null;
                    List<Installation> old = null;
                    while (AcceptWhileRunning(pipe, ui)) {
                        var input = new BinaryReader(pipe);
                        var output = new BinaryWriter(pipe);
                        string command = input.ReadString(), value = input.ReadString();
                        int code = 1;
                        try {
                            if (command == "scope" && !complete) {
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
                                if (old.Count != 0 && MessageBox.Show("Install in " + dest + ", then uninstall these copies?\n\n" +
                                    String.Join("\n", old.Select(i => i.Root)), title, MessageBoxButtons.OKCancel,
                                    MessageBoxIcon.Question, MessageBoxDefaultButton.Button2) != DialogResult.OK) code = 2;
                                else {
                                    if (machine || old.Any(i => i.Machine)) admin = new Elevation(machine, new IntPtr(Int64.Parse(scope[1])));
                                    choice = machine;
                                    code = 0;
                                }
                            } else if (command == "install" && choice.HasValue && !complete) {
                                bool machine = choice.Value;
                                TaskArgs(value);
                                var inventory = Inventory();
                                if (!Equal(dest, Destination(inventory, machine)) ||
                                    !old.Select(i => i.Uninstaller).SequenceEqual(inventory.Where(i => i.Id != ScopeId(machine)).Select(i => i.Uninstaller),
                                        StringComparer.OrdinalIgnoreCase)) throw new IOException("Installations changed. Run setup again.");
                                ValidatePlan(inventory, ScopeId(machine), dest);
                                if (machine) admin.Run("install", value); else InstallScope(false, value);
                                VerifyProduct(dest, machine, config["version"]);
                                foreach (var item in old.Where(i => !i.Machine)) RemoveOld(item);
                                if (admin != null) admin.Run("cleanup");
                                if (!machine && old.Any(i => !i.Machine)) InstallScope(false, value);
                                var final = Inventory();
                                if (final.Count != 1 || final[0].Id != ScopeId(machine) || !Equal(final[0].Root, dest))
                                    throw new IOException("Installation verification failed.");
                                complete = true; code = 0;
                            } else if (command == "launch" && complete) {
                                Process.Start(new ProcessStartInfo(Path.Combine(dest, "Codex.exe")) { UseShellExecute = false });
                                code = 0;
                            }
                        } catch (System.ComponentModel.Win32Exception e) {
                            if (e.NativeErrorCode == 1223) code = 2; else MessageBox.Show(e.Message, title);
                        } catch (Exception e) { MessageBox.Show(e.Message, title); }
                        output.Write(code); output.Flush();
                        input.ReadBoolean(); pipe.Disconnect();
                    }
                    return complete ? 0 : 2;
                }
            } finally { File.Delete(wizard); }
        } finally { if (admin != null) admin.Dispose(); File.Delete(plan); }
    }
}
