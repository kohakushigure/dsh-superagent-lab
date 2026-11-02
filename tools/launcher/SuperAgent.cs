using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Threading;

// SuperAgent.exe - 桌面入口：拉起 loop 全家桶（start-all.ps1），等健康检查，然后打开控制台。
// 约束：不写仓库外的任何文件；只调用本仓库内的脚本。
class SuperAgent
{
    static string Root(string exePath)
    {
        var dir = Path.GetDirectoryName(Path.GetFullPath(exePath));
        // exe 放在仓库根；若被拷到别处，则向上找 dsh-superagent 里的 local-superagent
        for (var d = new DirectoryInfo(dir); d != null; d = d.Parent)
        {
            if (Directory.Exists(Path.Combine(d.FullName, "local-superagent"))) return d.FullName;
        }
        return dir;
    }

    static int RunPowerShell(string root, string args, bool wait)
    {
        var psi = new ProcessStartInfo("powershell.exe",
            "-NoProfile -ExecutionPolicy Bypass -File \"" + Path.Combine(root, "scripts\\hosting\\start-all.ps1") + "\" " + args)
        {
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
            WorkingDirectory = root
        };
        using (var p = Process.Start(psi))
        {
            string output = p.StandardOutput.ReadToEnd() + p.StandardError.ReadToEnd();
            if (wait) p.WaitForExit(120000);
            if (!string.IsNullOrWhiteSpace(output)) Console.Write(output);
            return p.HasExited ? p.ExitCode : 0;
        }
    }

    static bool Health(int port, int timeoutMs)
    {
        var sw = Stopwatch.StartNew();
        while (sw.ElapsedMilliseconds < timeoutMs)
        {
            try
            {
                var req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + port + "/api/health");
                req.Timeout = 2000;
                using (var res = (HttpWebResponse)req.GetResponse())
                using (var sr = new StreamReader(res.GetResponseStream()))
                {
                    var body = sr.ReadToEnd();
                    if (res.StatusCode == HttpStatusCode.OK && body.Contains("\"ok\"")) return true;
                }
            }
            catch { }
            Thread.Sleep(500);
        }
        return false;
    }

    static int Main(string[] argv)
    {
        var root = Root(Environment.GetCommandLineArgs()[0]);
        var port = 3082;
        bool stop = false;
        bool status = false;
        bool open = true;

        foreach (var a in argv)
        {
            if (a == "--stop") stop = true;
            else if (a == "--status") status = true;
            else if (a == "--no-open") open = false;
            else if (a.StartsWith("--port=")) int.TryParse(a.Substring(7), out port);
        }

        Console.WriteLine("repo      : " + root);
        Console.WriteLine("console   : http://127.0.0.1:" + port + "/");

        if (stop) { RunPowerShell(root, "-Port " + port + " -Stop", true); Console.WriteLine("stopped."); return 0; }
        if (status) { RunPowerShell(root, "-Port " + port + " -Status", true); return 0; }

        // start-all 是幂等的：已跑的不重起，缺的组件（巡检/看门狗）会被补上
        Console.WriteLine("ensuring loop + selfcheck + watchdog ...");
        RunPowerShell(root, "-Port " + port, true);

        if (!Health(port, 30000))
        {
            Console.WriteLine("health check failed - see local-superagent/evidence/hosting/*.log");
            return 1;
        }

        Console.WriteLine("up. llm mode and counters are on the console.");
        if (open)
        {
            try { Process.Start(new ProcessStartInfo("http://127.0.0.1:" + port + "/") { UseShellExecute = true }); }
            catch (Exception e) { Console.WriteLine("could not open browser: " + e.Message); }
        }
        return 0;
    }
}