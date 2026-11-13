using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Threading;
using System.Windows.Forms;

class ScarletLauncher {
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")] static extern bool ShowWindowAsync(IntPtr window, int state);
    static readonly string Root = AppDomain.CurrentDomain.BaseDirectory;
    static readonly string App = Path.Combine(Environment.GetEnvironmentVariable("LOCALAPPDATA"), "Scarlet", "scarlet-desktop.exe");
    static readonly string UserId = WindowsIdentity.GetCurrent().User.Value;
    const int Ready = 3, Busy = 4;

    static string ReadStatus() {
        try {
            using (var stream = new FileStream(Path.Combine(Root, "status.txt"), FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
            using (var reader = new StreamReader(stream)) return reader.ReadToEnd().Trim();
        }
        catch (IOException) { return "Preparing Scarlet…"; }
    }
    static Process StartUpdater(string mode) {
        var node = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs", "node.exe");
        return Process.Start(new ProcessStartInfo(node, "\"" + Path.Combine(Root, "update.mjs") + "\" " + mode) {
            WorkingDirectory = Root, UseShellExecute = false, CreateNoWindow = true
        });
    }
    static int RunUpdater(string mode) {
        using (var child = StartUpdater(mode)) { child.WaitForExit(); return child.ExitCode; }
    }
    static bool Enter(Mutex mutex, int timeout = Timeout.Infinite) {
        try { return mutex.WaitOne(timeout); }
        catch (AbandonedMutexException) { return true; }
    }

    // Only a missing or damaged installation needs a foreground build.
    static bool Bootstrap() {
        using (var child = StartUpdater("--prepare-only")) {
            var elapsed = Stopwatch.StartNew();
            Form progress = null;
            Label message = null;
            bool open = true;
            while (!child.WaitForExit(250)) {
                if (open && elapsed.ElapsedMilliseconds > 4500) {
                    if (progress == null) {
                        progress = new Form { Text = "Preparing Scarlet", Width = 480, Height = 145,
                            StartPosition = FormStartPosition.CenterScreen, FormBorderStyle = FormBorderStyle.FixedDialog,
                            MaximizeBox = false, Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath) };
                        message = new Label { Left = 18, Top = 15, Width = 430, Height = 42 };
                        progress.Controls.Add(message);
                        progress.Controls.Add(new ProgressBar { Left = 18, Top = 64, Width = 425, Height = 8, Style = ProgressBarStyle.Marquee });
                        progress.FormClosed += (s,e) => { open = false; };
                        progress.Show();
                    }
                    message.Text = ReadStatus();
                }
                if (progress != null) Application.DoEvents();
            }
            if (progress != null) progress.Dispose();
            if (child.ExitCode != 0 && open) throw new InvalidOperationException(ReadStatus() + "\n\nDetails: " + Path.Combine(Root, "launch.log"));
            return child.ExitCode == 0 && open;
        }
    }
    static bool OpenApp() {
        string otherRelease = null;
        foreach (var p in Process.GetProcessesByName("scarlet-desktop")) {
            using (p) {
                try {
                    if (p.SessionId != Process.GetCurrentProcess().SessionId) continue;
                    string running = p.MainModule.FileName;
                    if (!String.Equals(running, App, StringComparison.OrdinalIgnoreCase)) {
                        if (running.IndexOf(@"\debug\", StringComparison.OrdinalIgnoreCase) < 0) otherRelease = running;
                        continue;
                    }
                    var h = p.MainWindowHandle;
                    if (h != IntPtr.Zero) { if (IsIconic(h)) ShowWindowAsync(h, 9); SetForegroundWindow(h); }
                    return true;
                } catch (InvalidOperationException) { }
            }
        }
        if (otherRelease != null) {
            MessageBox.Show("Another Scarlet release is already open. Save your work and quit it, then open Scarlet again.\n\n" + otherRelease, "Scarlet");
            return false;
        }
        using (Process.Start(new ProcessStartInfo(App) { UseShellExecute = false, WorkingDirectory = Path.GetDirectoryName(App) })) { }
        return true;
    }

    // Wait outside the launch/install mutex so additional shortcut clicks can reopen the editor.
    static void WaitForAppExit() {
        foreach (string name in new[] { "scarlet-desktop", "scarlet-engine" }) {
            string installedPath = Path.Combine(Path.GetDirectoryName(App), name + ".exe");
            foreach (var p in Process.GetProcessesByName(name)) {
                using (p) {
                    try {
                        if (String.Equals(p.MainModule.FileName, installedPath, StringComparison.OrdinalIgnoreCase)) p.WaitForExit();
                    } catch (InvalidOperationException) { } // Already exited.
                    catch (Win32Exception) { } // The installer also checks for live processes.
                }
            }
        }
    }
    static int Update(Mutex launch, bool background) {
        for (;;) {
            int result = RunUpdater("--stage-only");
            if (result != Ready) return result;
            do {
                if (background) WaitForAppExit();
                Enter(launch);
                try { result = RunUpdater("--apply-ready"); }
                finally { launch.ReleaseMutex(); }
                if (result == Busy && background) Thread.Sleep(500);
            } while (result == Busy && background);
            if (result != 0) return result;
        }
    }
    static int Launch(Mutex launch) {
        Enter(launch);
        try {
            if (RunUpdater("--verify-local") == 0) {
                if (!OpenApp()) return 1;
                using (Process.Start(new ProcessStartInfo(Application.ExecutablePath, "--background") {
                    UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = Root
                })) { }
                return 0;
            }
        } finally { launch.ReleaseMutex(); }
        return -1; // Enter the serialized bootstrap path.
    }

    [STAThread]
    static int Main(string[] args) {
        bool interactive = args.Length == 0;
        string mode = args.Length == 1 ? args[0] : "";
        if (!interactive && mode != "--prepare-only" && mode != "--check-only" && mode != "--background") return 2;
        try {
            using (var launch = new Mutex(false, @"Local\ScarletLaunch-" + UserId))
            using (var update = new Mutex(false, @"Local\ScarletMain-" + UserId)) {
                if (interactive) {
                    int result = Launch(launch);
                    if (result >= 0) return result;
                }
                if (!Enter(update, interactive ? Timeout.Infinite : 0)) return Busy;
                try {
                    if (mode == "--check-only") return RunUpdater(mode);
                    if (!interactive) return Update(launch, mode == "--background");
                    Enter(launch);
                    try {
                        if (RunUpdater("--verify-local") != 0 && !Bootstrap()) return 1;
                        return OpenApp() ? 0 : 1;
                    } finally { launch.ReleaseMutex(); }
                } finally { update.ReleaseMutex(); }
            }
        } catch (Exception ex) {
            if (interactive) MessageBox.Show(ex.Message, "Scarlet", MessageBoxButtons.OK, MessageBoxIcon.Information);
            return 1;
        }
    }
}
