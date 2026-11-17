using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace VideoDownloaderApp
{
    internal static class Program
    {
        [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr handle);
        [DllImport("user32.dll")] private static extern bool ShowWindowAsync(IntPtr handle, int command);

        [STAThread]
        private static void Main(string[] args)
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            string root = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
            string key = "Local\\VideoDownloaderApp_" + Regex.Replace(root, @"[^\w]", "_");
            bool first;
            using (var instance = new Mutex(true, key, out first))
            {
                if (!first)
                {
                    foreach (var process in Process.GetProcessesByName(Path.GetFileNameWithoutExtension(Application.ExecutablePath)))
                    {
                        try
                        {
                            if (process.Id != Process.GetCurrentProcess().Id && String.Equals(process.MainModule.FileName, Application.ExecutablePath, StringComparison.OrdinalIgnoreCase))
                            {
                                ShowWindowAsync(process.MainWindowHandle, 9);
                                SetForegroundWindow(process.MainWindowHandle);
                                return;
                            }
                        }
                        catch { }
                    }
                    return;
                }
                Application.Run(new MainForm(root, args.Length == 2 && args[0] == "--url" ? args[1] : null));
            }
        }
    }

    internal sealed partial class MainForm : Form
    {
        private readonly string root;
        private readonly string suggestedUrl;
        private readonly HttpClient http = new HttpClient(new HttpClientHandler { UseProxy = false });
        private readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = 4 * 1024 * 1024 };
        private readonly TextBox urlInput = new TextBox();
        private readonly DeskSelect quality = new DeskSelect();
        private readonly DeskButton download = new DeskButton();
        private readonly DeskButton pickFolder = new DeskButton();
        private readonly DeskButton openFolder = new DeskButton();
        private readonly DeskButton clearHistory = new DeskButton();
        private readonly DeskButton reconnect = new DeskButton();
        private readonly Label directory = new Label();
        private readonly Label connection = new Label();
        private readonly EmptyState empty = new EmptyState();
        private readonly FlowLayoutPanel jobsPanel = new FlowLayoutPanel();
        private readonly Dictionary<string, JobCard> cards = new Dictionary<string, JobCard>();
        private readonly AccessNotices accessNotices = new AccessNotices();
        private readonly System.Windows.Forms.Timer poll = new System.Windows.Forms.Timer { Interval = 1000 };
        private readonly string[] qualityValues = { "best", "2160p", "1080p", "720p" };
        private string baseUrl;
        private string token;
        private string savedQuality = "best";
        private bool changingQuality;
        private bool refreshing;
        private bool connecting;
        private bool showingAccessNotice;
        private bool closing;
        private bool closeApproved;
        private bool closeAfterConnect;
        private int backendPid;
        private int activeCount;

        internal MainForm(string projectRoot, string initialUrl)
        {
            root = projectRoot;
            suggestedUrl = initialUrl;
            BuildInterface();
            SetReady(false);
            Shown += async delegate { await ConnectAsync(); };
            reconnect.Click += async delegate { await ConnectAsync(); };
            download.Click += async delegate { await DownloadAsync(); };
            urlInput.KeyDown += delegate(object sender, KeyEventArgs e) { if (e.KeyCode == Keys.Enter && download.Enabled) { e.SuppressKeyPress = true; download.PerformClick(); } };
            quality.SelectedIndexChanged += async delegate { await SaveQualityAsync(); };
            pickFolder.Click += async delegate { await PickFolderAsync(); };
            openFolder.Click += async delegate { await ActionAsync("/api/reveal", new { dir = 1 }); };
            extensionButton.Click += async delegate { await InstallExtensionAsync(); };
            clearHistory.Click += async delegate { await ActionAsync("/api/clear-history", new { }); await RefreshJobsAsync(); };
            poll.Tick += async delegate { await RefreshJobsAsync(); };
            FormClosing += HandleFormClosing;
            FormClosed += delegate { poll.Stop(); http.Dispose(); DisposeDesktopView(); };
        }

        internal static string Str(Dictionary<string, object> value, string key)
        {
            object result; return value.TryGetValue(key, out result) && result != null ? Convert.ToString(result, CultureInfo.InvariantCulture) : "";
        }

        internal static double Num(Dictionary<string, object> value, string key)
        {
            double number; return Double.TryParse(Str(value, key), NumberStyles.Any, CultureInfo.InvariantCulture, out number) ? number : 0;
        }

        private void SetReady(bool ready)
        {
            download.Enabled = ready; quality.Enabled = ready; pickFolder.Enabled = ready; openFolder.Enabled = ready; clearHistory.Enabled = ready; extensionButton.Enabled = ready;
        }

        private void Status(string text, bool error)
        {
            if (IsDisposed) return;
            PresentStatus(text, error);
        }

        private static string LocalUrl(string value)
        {
            Uri uri;
            if (!Uri.TryCreate(value, UriKind.Absolute, out uri) || uri.Scheme != "http" || (uri.Host != "127.0.0.1" && uri.Host != "localhost") || uri.Port < 1024 || uri.AbsolutePath != "/" || uri.UserInfo.Length != 0 || uri.Query.Length != 0 || uri.Fragment.Length != 0) return null;
            return "http://127.0.0.1:" + uri.Port;
        }

        private async Task<Dictionary<string, object>> ProbeAsync(string address)
        {
            try
            {
                using (var timeout = new CancellationTokenSource(650))
                using (var response = await http.GetAsync(address + "/api/config", timeout.Token))
                {
                    response.EnsureSuccessStatusCode();
                    var config = json.Deserialize<Dictionary<string, object>>(await response.Content.ReadAsStringAsync());
                    if (Str(config, "app") != "video-downloader-desktop" || Num(config, "desktopApi") < 1) return null;
                    using (var process = Process.GetProcessById((int)Num(config, "pid")))
                    {
                        if (!String.Equals(process.MainModule.FileName, Path.Combine(root, "bin", "node.exe"), StringComparison.OrdinalIgnoreCase)) return null;
                    }
                    config["address"] = address;
                    return config;
                }
            }
            catch { return null; }
        }

        private async Task<Dictionary<string, object>> FindBackendAsync()
        {
            var preferred = LocalUrl(suggestedUrl);
            if (preferred != null) { var result = await ProbeAsync(preferred); if (result != null) return result; }
            var results = await Task.WhenAll(Enumerable.Range(3210, 10).Select(port => ProbeAsync("http://127.0.0.1:" + port)));
            return results.FirstOrDefault(result => result != null);
        }

        private async Task PrepareBackendAsync()
        {
            if (new[] { "node.exe", "yt-dlp.exe", "ffmpeg.exe" }.Any(file => !File.Exists(Path.Combine(root, "bin", file))))
            {
                Status("首次使用，正在准备下载组件，请稍等…", false);
                var setup = new ProcessStartInfo(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), @"WindowsPowerShell\v1.0\powershell.exe"));
                setup.Arguments = "-NoProfile -ExecutionPolicy Bypass -File \"" + Path.Combine(root, "scripts", "install-windows.ps1") + "\" -Json";
                setup.UseShellExecute = false; setup.CreateNoWindow = true; setup.RedirectStandardOutput = true; setup.RedirectStandardError = true; setup.WorkingDirectory = root;
                using (var process = Process.Start(setup))
                {
                    var output = process.StandardOutput.ReadToEndAsync(); var errors = process.StandardError.ReadToEndAsync();
                    await Task.Run(() => process.WaitForExit());
                    await output; await errors;
                    if (process.ExitCode != 0) throw new Exception("组件准备失败，请查看 bin\\setup-last.log 后重试。");
                }
                return;
            }
            var start = new ProcessStartInfo(Path.Combine(root, "bin", "node.exe"), "\"" + Path.Combine(root, "server.js") + "\"");
            start.WorkingDirectory = root; start.UseShellExecute = false; start.CreateNoWindow = true;
            start.EnvironmentVariables["NO_OPEN"] = "1"; start.EnvironmentVariables["PORT"] = "";
            using (var process = Process.Start(start)) { }
        }

        private async Task ConnectAsync()
        {
            if (connecting) return;
            connecting = true; poll.Stop(); SetReady(false); reconnect.Visible = false;
            try
            {
                Status("正在连接下载服务…", false);
                var config = await FindBackendAsync();
                if (config == null)
                {
                    await PrepareBackendAsync();
                    for (int attempt = 0; attempt < 40 && config == null; attempt++) { await Task.Delay(300); config = await FindBackendAsync(); }
                }
                if (config == null) throw new Exception("下载服务未能启动，请点击重新连接。");
                if (!Convert.ToBoolean(config["ytdlp"]) || !Convert.ToBoolean(config["ffmpeg"]) || !Convert.ToBoolean(config["jsRuntime"])) throw new Exception("下载组件尚未就绪，请重新启动软件并检查 bin\\setup-last.log。");
                baseUrl = Str(config, "address");
                backendPid = (int)Num(config, "pid");
                var page = await http.GetStringAsync(baseUrl + "/");
                var match = Regex.Match(page, "const API_TOKEN=\"([A-Za-z0-9_-]+)\";");
                if (!match.Success) throw new Exception("无法连接当前下载服务，请重新启动软件。");
                token = match.Groups[1].Value;
                directory.Text = Str(config, "dir"); directory.Tag = directory.Text;
                savedQuality = Str(config, "quality");
                changingQuality = true; quality.SelectedIndex = Math.Max(0, Array.IndexOf(qualityValues, savedQuality)); changingQuality = false;
                lastConfig = config; UpdateDiagnostics();
                SetReady(true); await RefreshJobsAsync(); poll.Start(); urlInput.Focus();
                Status("已就绪 · 本地运行 · 关闭窗口时停止下载服务", false);
            }
            catch (Exception error) { Status(error.Message, true); reconnect.Visible = true; }
            finally
            {
                connecting = false;
                if (closeAfterConnect && !IsDisposed) { closeAfterConnect = false; BeginInvoke(new Action(Close)); }
            }
        }

        private bool BackendStillRunning()
        {
            if (backendPid <= 0) return false;
            try
            {
                using (var process = Process.GetProcessById(backendPid))
                    return !process.HasExited && String.Equals(process.MainModule.FileName, Path.Combine(root, "bin", "node.exe"), StringComparison.OrdinalIgnoreCase);
            }
            catch (ArgumentException) { return false; }
            catch (InvalidOperationException) { return false; }
            catch { return true; }
        }

        private async void HandleFormClosing(object sender, FormClosingEventArgs e)
        {
            if (closeApproved || e.CloseReason == CloseReason.WindowsShutDown) return;
            e.Cancel = true;
            if (closing) return;
            if (connecting)
            {
                closeAfterConnect = true;
                Status("正在完成服务连接，随后关闭…", false);
                return;
            }
            if (baseUrl == null) { closeApproved = true; BeginInvoke(new Action(Close)); return; }
            closing = true; poll.Stop(); SetReady(false);
            try
            {
                var result = (await ApiAsync("/api/shutdown", new { force = false })) as Dictionary<string, object>;
                if (result == null) throw new Exception("下载服务返回了无效响应。");
                if (!Convert.ToBoolean(result["ok"]))
                {
                    int count = (int)Num(result, "running");
                    var answer = MessageBox.Show(this, "还有 " + count + " 个任务正在下载。退出将停止这些任务。\r\n\r\n是否停止下载并退出？", "下载正在进行", MessageBoxButtons.YesNo, MessageBoxIcon.Warning, MessageBoxDefaultButton.Button2);
                    if (answer != DialogResult.Yes) return;
                    result = (await ApiAsync("/api/shutdown", new { force = true })) as Dictionary<string, object>;
                    if (result == null || !Convert.ToBoolean(result["ok"])) throw new Exception("下载服务未能停止。");
                }
                for (int i = 0; i < 50 && BackendStillRunning(); i++) await Task.Delay(100);
                if (BackendStillRunning()) throw new Exception("后台下载服务尚未退出，请稍后重试。");
                closeApproved = true;
                BeginInvoke(new Action(Close));
            }
            catch (Exception error)
            {
                if (!BackendStillRunning()) { closeApproved = true; BeginInvoke(new Action(Close)); return; }
                MessageBox.Show(this, "无法停止后台下载服务，窗口将保持打开。\r\n\r\n" + error.Message, "退出失败", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
            finally
            {
                closing = false;
                if (!closeApproved && !IsDisposed) { SetReady(true); poll.Start(); }
            }
        }

        private async Task<object> ApiAsync(string route, object body)
        {
            using (var request = new HttpRequestMessage(body == null ? HttpMethod.Get : HttpMethod.Post, baseUrl + route))
            {
                if (body != null)
                {
                    request.Headers.Add("X-Video-Downloader-Token", token);
                    request.Headers.Add("Origin", baseUrl);
                    request.Content = new StringContent(json.Serialize(body), Encoding.UTF8, "application/json");
                }
                using (var timeout = new CancellationTokenSource(body == null ? 4000 : 60000))
                using (var response = await http.SendAsync(request, timeout.Token))
                {
                    var result = json.DeserializeObject(await response.Content.ReadAsStringAsync());
                    if (!response.IsSuccessStatusCode)
                    {
                        var error = result as Dictionary<string, object>;
                        throw new Exception(error != null ? Str(error, "err") : "操作失败，请重试。");
                    }
                    return result;
                }
            }
        }

        private async Task ActionAsync(string route, object body)
        {
            try { await ApiAsync(route, body); }
            catch (Exception error) { Status(error.Message, true); }
        }

        private async Task InstallExtensionAsync()
        {
            string extensionDir = Path.Combine(root, "browser-extension");
            if (!File.Exists(Path.Combine(extensionDir, "manifest.json"))) { Status("没有找到浏览器扩展文件，请检查软件目录。", true); return; }
            var choice = MessageBox.Show(this, "选择浏览器：\r\n\r\n是：Chrome\r\n否：Edge", "安装浏览器扩展", MessageBoxButtons.YesNoCancel, MessageBoxIcon.Question);
            if (choice == DialogResult.Cancel) return;
            extensionButton.Enabled = false;
            try
            {
                var result = (await ApiAsync("/api/extension/pair-code", new { })) as Dictionary<string, object>;
                string code = new Uri(baseUrl).Port.ToString(CultureInfo.InvariantCulture) + "-" + Str(result, "code");
                bool copied = false; try { Clipboard.SetText(code); copied = true; } catch { }
                string browser = choice == DialogResult.Yes ? "Chrome" : "Edge";
                string page = choice == DialogResult.Yes ? "chrome://extensions" : "edge://extensions";
                try { Process.Start(new ProcessStartInfo { FileName = choice == DialogResult.Yes ? "chrome.exe" : "msedge.exe", Arguments = page, UseShellExecute = true }); }
                catch { Status("请手动在 " + browser + " 地址栏打开 " + page, true); }
                try { Process.Start(new ProcessStartInfo { FileName = "explorer.exe", Arguments = "\"" + extensionDir + "\"", UseShellExecute = true }); } catch { }
                MessageBox.Show(this,
                    "1. 在 " + browser + " 的扩展页面开启“开发者模式”。\r\n" +
                    "2. 点击“加载已解压的扩展程序”，选择下面的文件夹：\r\n" + extensionDir + "\r\n\r\n" +
                    "3. 打开安装好的扩展，输入配对码并点击“连接”：\r\n" + code + (copied ? "（已复制）" : "") + "\r\n\r\n" +
                    "4. 打开并登录视频网站，再点击扩展中的“同步当前网站”。\r\n配对码 10 分钟内有效。",
                    "安装和连接扩展", MessageBoxButtons.OK, MessageBoxIcon.Information);
            }
            catch (Exception error) { Status(error.Message, true); }
            finally { extensionButton.Enabled = baseUrl != null; }
        }

        private async Task DownloadAsync()
        {
            if (String.IsNullOrWhiteSpace(urlInput.Text)) { Status("请先粘贴视频链接。", true); urlInput.Focus(); return; }
            string value = urlInput.Text.Trim();
            download.Enabled = false; quality.Enabled = false; download.Text = "正在添加…";
            try
            {
                await ApiAsync("/api/download", new { url = value, quality = qualityValues[quality.SelectedIndex] });
                urlInput.Clear(); Status("任务已添加，正在获取视频信息。", false); await RefreshJobsAsync();
            }
            catch (Exception error) { Status(error.Message, true); }
            finally { download.Enabled = true; quality.Enabled = true; download.Text = "开始下载"; }
        }

        private async Task SaveQualityAsync()
        {
            if (changingQuality || baseUrl == null || quality.SelectedIndex < 0) return;
            quality.Enabled = false; download.Enabled = false;
            try
            {
                string selected = qualityValues[quality.SelectedIndex];
                await ApiAsync("/api/quality", new { quality = selected }); savedQuality = selected;
                Status("画质选择已保存。已创建的任务保持原画质。", false);
            }
            catch (Exception error)
            {
                changingQuality = true; quality.SelectedIndex = Math.Max(0, Array.IndexOf(qualityValues, savedQuality)); changingQuality = false;
                Status(error.Message, true);
            }
            finally { quality.Enabled = true; download.Enabled = true; }
        }

        private async Task PickFolderAsync()
        {
            using (var dialog = new FolderBrowserDialog { Description = "选择视频保存文件夹", SelectedPath = Convert.ToString(directory.Tag), ShowNewFolderButton = true })
            {
                if (dialog.ShowDialog(this) != DialogResult.OK) return;
                try { await ApiAsync("/api/directory", new { dir = dialog.SelectedPath }); directory.Text = dialog.SelectedPath; directory.Tag = dialog.SelectedPath; ReflowDesktop(); Status("保存位置已更新。", false); }
                catch (Exception error) { Status(error.Message, true); }
            }
        }

        private async Task RefreshJobsAsync()
        {
            if (refreshing || baseUrl == null || IsDisposed) return;
            refreshing = true;
            try
            {
                var list = (await ApiAsync("/api/jobs", null)) as object[] ?? new object[0];
                var present = new HashSet<string>();
                activeCount = 0; int position = 0; int settled = 0;
                jobsPanel.SuspendLayout();
                foreach (Dictionary<string, object> item in list)
                {
                    string id = Str(item, "id"); present.Add(id);
                    accessNotices.Observe(id, Str(item, "status"), Str(item, "accessIssue"), Str(item, "err"));
                    if (Str(item, "status") == "running") activeCount++; else settled++;
                    JobCard card;
                    if (!cards.TryGetValue(id, out card))
                    {
                        card = new JobCard(palette); cards.Add(id, card); jobsPanel.Controls.Add(card);
                        string jobId = id;
                        card.ActionClicked += async delegate(string action) { await ActionAsync(action == "retry" ? "/api/retry" : "/api/reveal", new { id = jobId }); await RefreshJobsAsync(); };
                    }
                    card.UpdateJob(item); jobsPanel.Controls.SetChildIndex(card, position++);
                }
                foreach (string id in cards.Keys.Where(id => !present.Contains(id)).ToArray()) { cards[id].Dispose(); cards.Remove(id); }
                empty.Visible = list.Length == 0; clearHistory.Enabled = settled > 0;
                count.Text = list.Length.ToString(CultureInfo.InvariantCulture);
                ResizeCards(); jobsPanel.ResumeLayout();
                accessNotices.FinishRefresh(present);
            }
            catch (Exception error)
            {
                jobsPanel.ResumeLayout();
                if (!IsDisposed) { Status("连接中断：" + error.Message, true); reconnect.Visible = true; }
            }
            finally { refreshing = false; }
            ShowAccessNotices();
        }

        private void ShowAccessNotices()
        {
            if (showingAccessNotice || IsDisposed) return;
            showingAccessNotice = true;
            try
            {
                AccessNotice notice;
                while (!IsDisposed && (notice = accessNotices.Dequeue()) != null)
                {
                    string title = notice.Kind == "login" ? "需要登录或访问权限" : "需要网站验证";
                    string explanation = notice.Kind == "login"
                        ? "请先在视频网站确认账号拥有观看权限。浏览器登录后，是否能下载还取决于平台和该视频的限制。"
                        : "网站可能要求验证访问或提供访客会话，不一定需要登录。请先确认在浏览器中能否正常观看。";
                    string detail = String.IsNullOrWhiteSpace(notice.Detail) ? "" : notice.Detail + "\r\n\r\n";
                    MessageBox.Show(this, detail + explanation, title, MessageBoxButtons.OK, MessageBoxIcon.Information);
                }
            }
            finally { showingAccessNotice = false; }
        }

        private void ResizeCards()
        {
            ReflowDesktop();
        }
    }

}
