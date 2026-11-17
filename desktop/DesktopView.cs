using System;
using System.Collections.Generic;
using System.Drawing;
using System.Linq;
using System.Runtime.InteropServices;
using System.Windows.Forms;
using Microsoft.Win32;

namespace VideoDownloaderApp
{
    internal sealed partial class MainForm
    {
        [DllImport("dwmapi.dll")] private static extern int DwmSetWindowAttribute(IntPtr handle, int attribute, ref int value, int size);
        private DeskPalette palette;
        private readonly Panel viewport = new Panel(), content = new Panel(), heading = new Panel(), logHeading = new Panel(), footer = new Panel();
        private readonly DeskPanel intake = new DeskPanel(), inputWrap = new DeskPanel(), diagnostics = new DeskPanel();
        private readonly DeskBar bezel = new DeskBar();
        private readonly DeskButton themeButton = new DeskButton(), diagnosticsButton = new DeskButton();
        private readonly StatusDot statusDot = new StatusDot();
        private readonly Label wordmark = new Label(), qualityLabel = new Label(), destinationLabel = new Label(), hint = new Label(), logTitle = new Label(), count = new Label();
        private readonly Label formError = new Label(), privacy = new Label(), diagnosticText = new Label();
        private readonly Label placeholder = new Label();
        private readonly ToolTip tooltips = new ToolTip();
        private readonly DeskButton extensionButton = new DeskButton(), projectButton = new DeskButton();
        private Dictionary<string, object> lastConfig;
        private bool viewReady, arrangingView, manualTheme, diagnosticsOpen, statusError;

        private void BuildInterface()
        {
            using (var graphics = CreateGraphics()) DeskDraw.Scale = graphics.DpiX / 96F;
            AutoScaleMode = AutoScaleMode.None;
            Text = "梨花下载器"; ClientSize = new Size(DeskDraw.S(840), DeskDraw.S(760));
            MinimumSize = new Size(DeskDraw.S(760), DeskDraw.S(590));
            StartPosition = FormStartPosition.CenterScreen;
            Font = new Font("Microsoft YaHei UI", 9F); DoubleBuffered = true;
            try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }
            palette = DeskPalette.Create(SystemDark());
            bezel.Dock = DockStyle.Top; bezel.Height = DeskDraw.S(3);
            viewport.Dock = DockStyle.Fill; viewport.AutoScroll = true;
            Controls.Add(viewport); Controls.Add(bezel); viewport.Controls.Add(content);
            content.Controls.AddRange(new Control[] { heading, intake, logHeading, jobsPanel, footer });

            wordmark.Text = "梨花下载器"; wordmark.Font = new Font(Font.FontFamily, 13F, FontStyle.Bold);
            connection.Font = new Font(Font.FontFamily, 8.5F); connection.AutoEllipsis = true;
            connection.TextAlign = ContentAlignment.MiddleLeft; connection.Text = "正在连接下载服务";
            themeButton.Text = "深色"; themeButton.Quiet = true; themeButton.Font = new Font(Font.FontFamily, 8F);
            themeButton.AccessibleName = "切换深色或浅色主题";
            heading.Controls.AddRange(new Control[] { wordmark, connection, statusDot, themeButton });
            themeButton.Click += delegate { manualTheme = true; ApplyPalette(DeskPalette.Create(!palette.Dark)); };

            inputWrap.Field = true; inputWrap.Controls.Add(urlInput); intake.Controls.Add(inputWrap);
            urlInput.BorderStyle = BorderStyle.None; urlInput.Font = new Font(Font.FontFamily, 10.5F);
            urlInput.AccessibleName = "视频链接";
            placeholder.Text = "粘贴视频链接，支持抖音、B站、YouTube、X / Twitter 等"; placeholder.Font = urlInput.Font;
            urlInput.AccessibleDescription = placeholder.Text;
            inputWrap.Controls.Add(placeholder); placeholder.BringToFront();
            placeholder.Click += delegate { urlInput.Focus(); };
            urlInput.TextChanged += delegate { placeholder.Visible = urlInput.TextLength == 0; };
            urlInput.GotFocus += delegate { inputWrap.FocusedField = true; inputWrap.Invalidate(); };
            urlInput.LostFocus += delegate { inputWrap.FocusedField = false; inputWrap.Invalidate(); };
            download.Text = "开始下载"; download.Primary = true; download.Font = new Font(Font.FontFamily, 10.5F);
            qualityLabel.Text = "画质"; qualityLabel.TextAlign = ContentAlignment.MiddleLeft;
            quality.Items.AddRange(new object[] { "自动最佳", "4K 优先", "1080p 优先", "720p 优先" }); quality.SelectedIndex = 0;
            quality.AccessibleName = "下载画质"; quality.Font = new Font(Font.FontFamily, 9F);
            destinationLabel.Text = "存到"; destinationLabel.TextAlign = ContentAlignment.MiddleLeft;
            directory.Font = new Font("Consolas", 8.5F); directory.TextAlign = ContentAlignment.MiddleLeft; directory.AutoEllipsis = true;
            directory.Padding = new Padding(DeskDraw.S(7), 0, DeskDraw.S(7), 0); directory.Text = "正在读取…";
            pickFolder.Text = "更改"; openFolder.Text = "打开";
            hint.Text = "选择会自动保存。没有对应档位时按可用版本回退，不会放大画面；抖音和央视频沿用原站画质。";
            hint.Font = new Font(Font.FontFamily, 8.3F);
            formError.Font = new Font(Font.FontFamily, 8.8F); formError.Visible = false;
            intake.Controls.AddRange(new Control[] { download, qualityLabel, quality, destinationLabel, directory, pickFolder, openFolder, hint, formError });
            intake.Paint += delegate(object sender, PaintEventArgs e)
            {
                using (var pen = new Pen(palette.Rule)) e.Graphics.DrawLine(pen, DeskDraw.S(21), DeskDraw.S(88) + FormErrorHeight(), intake.Width - DeskDraw.S(21), DeskDraw.S(88) + FormErrorHeight());
            };
            logTitle.Text = "下载记录"; logTitle.Font = new Font(Font.FontFamily, 9F, FontStyle.Bold);
            count.Font = new Font("Consolas", 8.5F); count.Text = "0";
            clearHistory.Text = "清空记录"; clearHistory.Font = new Font(Font.FontFamily, 8.5F);
            tooltips.SetToolTip(clearHistory, "清除已完成和失败的记录，不会删除视频或中断下载。");
            logHeading.Controls.AddRange(new Control[] { logTitle, count, clearHistory });
            logHeading.Paint += delegate(object sender, PaintEventArgs e) { using (var pen = new Pen(palette.StrongRule)) e.Graphics.DrawLine(pen, 0, logHeading.Height - 1, logHeading.Width, logHeading.Height - 1); };
            jobsPanel.FlowDirection = FlowDirection.TopDown; jobsPanel.WrapContents = false; jobsPanel.AutoScroll = false;
            jobsPanel.Margin = Padding.Empty; jobsPanel.Padding = Padding.Empty; jobsPanel.Controls.Add(empty);

            privacy.Text = "文件只保存在这台电脑上，不会上传。请只下载你有权保存的内容。";
            privacy.Font = new Font(Font.FontFamily, 8.3F);
            diagnosticsButton.Text = "▸ 运行状态"; diagnosticsButton.Quiet = true; diagnosticsButton.Font = new Font(Font.FontFamily, 8.3F);
            diagnosticsButton.Click += delegate { diagnosticsOpen = !diagnosticsOpen; diagnostics.Visible = diagnosticsOpen; diagnosticsButton.Text = diagnosticsOpen ? "▾ 运行状态" : "▸ 运行状态"; ReflowDesktop(); };
            diagnosticText.Font = new Font(Font.FontFamily, 8.5F); diagnostics.Controls.Add(diagnosticText); diagnostics.Visible = false;
            reconnect.Text = "重新连接"; reconnect.Font = new Font(Font.FontFamily, 8.3F); reconnect.Visible = false;
            extensionButton.Text = "安装扩展"; extensionButton.Font = new Font(Font.FontFamily, 8.3F);
            tooltips.SetToolTip(extensionButton, "安装 Chrome / Edge 扩展以同步网站登录状态。");
            projectButton.Text = "项目主页 ↗"; projectButton.Quiet = true; projectButton.Font = new Font(Font.FontFamily, 8.3F);
            projectButton.AccessibleName = "打开 GitHub 项目主页";
            projectButton.Click += delegate
            {
                try { System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo("https://github.com/Furude-rika-mipa/rika-downloader") { UseShellExecute = true }); }
                catch { MessageBox.Show(this, "无法打开项目主页，请检查默认浏览器设置。", "梨花下载器", MessageBoxButtons.OK, MessageBoxIcon.Warning); }
            };
            reconnect.VisibleChanged += delegate { ReflowDesktop(); };
            footer.Controls.AddRange(new Control[] { privacy, diagnosticsButton, diagnostics, reconnect, projectButton, extensionButton });
            viewport.SizeChanged += delegate { ReflowDesktop(); };
            SystemEvents.UserPreferenceChanged += SystemThemeChanged;
            viewReady = true; ApplyPalette(palette); ReflowDesktop();
        }

        private static bool SystemDark()
        {
            try
            {
                using (var key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize"))
                    return key != null && Convert.ToInt32(key.GetValue("AppsUseLightTheme", 1)) == 0;
            }
            catch { return false; }
        }
        private void SystemThemeChanged(object sender, UserPreferenceChangedEventArgs e)
        {
            if (!manualTheme && IsHandleCreated && !IsDisposed) BeginInvoke((Action)(() => ApplyPalette(DeskPalette.Create(SystemDark()))));
        }
        private void ApplyPalette(DeskPalette theme)
        {
            palette = theme; BackColor = theme.Paper;
            foreach (var panel in new[] { viewport, content, heading, logHeading, jobsPanel, footer }) panel.BackColor = theme.Paper;
            bezel.Palette = theme; bezel.Invalidate();
            foreach (var panel in new[] { intake, inputWrap, diagnostics }) { panel.Palette = theme; panel.BackColor = panel.Field ? theme.Field : theme.Panel; panel.Invalidate(true); }
            foreach (var button in new[] { download, pickFolder, openFolder, clearHistory, reconnect, themeButton, diagnosticsButton, projectButton, extensionButton }) { button.Palette = theme; button.Invalidate(); }
            foreach (var label in new[] { wordmark, connection, qualityLabel, destinationLabel, hint, logTitle, count, privacy, formError, diagnosticText }) label.BackColor = Color.Transparent;
            wordmark.ForeColor = theme.Ink; logTitle.ForeColor = theme.Secondary; qualityLabel.ForeColor = theme.Muted; destinationLabel.ForeColor = theme.Muted;
            hint.ForeColor = theme.Muted; count.ForeColor = theme.Muted; privacy.ForeColor = theme.Muted; formError.ForeColor = theme.Bad;
            diagnosticText.ForeColor = theme.Secondary; connection.ForeColor = statusError ? theme.Bad : theme.Secondary;
            statusDot.BackColor = theme.Paper; statusDot.DotColor = statusError ? theme.Bad : baseUrl == null ? theme.Muted : theme.Good; statusDot.Invalidate();
            directory.BackColor = theme.Field; directory.ForeColor = theme.Secondary;
            urlInput.BackColor = theme.Field; urlInput.ForeColor = theme.Ink; placeholder.BackColor = theme.Field; placeholder.ForeColor = theme.Muted;
            quality.Palette = theme; quality.BackColor = theme.Panel; quality.ForeColor = theme.Ink; quality.Invalidate();
            empty.Palette = theme; empty.BackColor = theme.Paper; empty.Invalidate();
            foreach (var card in cards.Values) card.SetPalette(theme);
            themeButton.Text = theme.Dark ? "浅色" : "深色";
            try { int dark = theme.Dark ? 1 : 0; if (DwmSetWindowAttribute(Handle, 20, ref dark, sizeof(int)) != 0) DwmSetWindowAttribute(Handle, 19, ref dark, sizeof(int)); } catch { }
            Invalidate(true);
        }

        private int FormErrorHeight()
        {
            return !formError.Visible ? 0 : Math.Max(DeskDraw.S(28), TextRenderer.MeasureText(formError.Text, formError.Font,
                new Size(Math.Max(100, intake.Width - DeskDraw.S(42)), Int32.MaxValue), TextFormatFlags.WordBreak).Height + DeskDraw.S(10));
        }
        private void PresentStatus(string text, bool error)
        {
            if (IsDisposed) return;
            statusError = error; connection.Text = text.StartsWith("已就绪") ? "在本机运行，关闭窗口时停止服务" : text;
            connection.ForeColor = error ? palette.Bad : palette.Secondary;
            tooltips.SetToolTip(connection, text);
            statusDot.DotColor = error ? palette.Bad : baseUrl == null ? palette.Muted : palette.Good; statusDot.Invalidate();
            formError.Text = error ? text : ""; formError.Visible = error;
            ReflowDesktop();
        }
        private void UpdateDiagnostics()
        {
            if (lastConfig == null) { diagnosticText.Text = "正在连接下载服务…"; return; }
            Func<string, string> ready = key => Str(lastConfig, key).ToLowerInvariant() == "true" ? "就绪" : "未就绪";
            diagnosticText.Text = "下载引擎       yt-dlp " + ready("ytdlp") + "\r\n高清合并       ffmpeg " + ready("ffmpeg") +
                "\r\nYouTube 运行时  " + ready("jsRuntime") + "\r\n代理           " + (Str(lastConfig, "proxy").ToLowerInvariant() == "true" ? "已启用" : "未启用") +
                "\r\n\r\n优先尝试公开下载；需要登录时可使用本机已保存的浏览器会话。";
        }
        private void DirectoryCaption()
        {
            string full = Convert.ToString(directory.Tag);
            if (String.IsNullOrEmpty(full)) return;
            string visible = full;
            int width = Math.Max(20, directory.Width - DeskDraw.S(14));
            while (visible.Length > 4 && TextRenderer.MeasureText(visible, directory.Font).Width > width) visible = "…" + visible.Substring(visible.StartsWith("…") ? 2 : 1);
            directory.Text = visible; tooltips.SetToolTip(directory, full);
        }
        private void ReflowDesktop()
        {
            if (!viewReady || arrangingView || IsDisposed) return;
            arrangingView = true;
            try
            {
                int width = Math.Min(DeskDraw.S(700), Math.Max(DeskDraw.S(640), viewport.ClientSize.Width - DeskDraw.S(48)));
                int left = Math.Max(DeskDraw.S(14), (viewport.ClientSize.Width - width) / 2);
                content.SetBounds(left, DeskDraw.S(30) + viewport.AutoScrollPosition.Y, width, content.Height);
                heading.SetBounds(0, 0, width, DeskDraw.S(43));
                wordmark.SetBounds(0, 0, DeskDraw.S(155), DeskDraw.S(28));
                themeButton.SetBounds(width - DeskDraw.S(45), 0, DeskDraw.S(45), DeskDraw.S(27));
                int statusLeft = width - DeskDraw.S(360);
                connection.SetBounds(statusLeft, 0, DeskDraw.S(300), DeskDraw.S(27));
                statusDot.SetBounds(statusLeft - DeskDraw.S(16), 0, DeskDraw.S(12), DeskDraw.S(27));
                int extra = FormErrorHeight();
                intake.SetBounds(0, heading.Bottom, width, DeskDraw.S(204) + extra);
                int inner = width - DeskDraw.S(42), pad = DeskDraw.S(21);
                inputWrap.SetBounds(pad, pad, inner - DeskDraw.S(134), DeskDraw.S(52));
                urlInput.SetBounds(DeskDraw.S(15), (inputWrap.Height - urlInput.PreferredHeight) / 2, inputWrap.Width - DeskDraw.S(30), urlInput.PreferredHeight);
                placeholder.SetBounds(urlInput.Left, urlInput.Top + DeskDraw.S(1), urlInput.Width, urlInput.Height);
                download.SetBounds(width - pad - DeskDraw.S(124), pad, DeskDraw.S(124), DeskDraw.S(52));
                formError.SetBounds(pad, DeskDraw.S(82), inner, Math.Max(0, extra - DeskDraw.S(8)));
                int optionY = DeskDraw.S(104) + extra;
                qualityLabel.SetBounds(pad, optionY, DeskDraw.S(40), DeskDraw.S(32));
                quality.SetBounds(pad + DeskDraw.S(46), optionY, DeskDraw.S(133), DeskDraw.S(32));
                openFolder.SetBounds(width - pad - DeskDraw.S(48), optionY, DeskDraw.S(48), DeskDraw.S(32));
                pickFolder.SetBounds(openFolder.Left - DeskDraw.S(58), optionY, DeskDraw.S(50), DeskDraw.S(32));
                int pathWidth = Math.Min(DeskDraw.S(232), Math.Max(DeskDraw.S(130), width - DeskDraw.S(435)));
                directory.SetBounds(pickFolder.Left - DeskDraw.S(8) - pathWidth, optionY, pathWidth, DeskDraw.S(32));
                destinationLabel.SetBounds(directory.Left - DeskDraw.S(40), optionY, DeskDraw.S(36), DeskDraw.S(32));
                hint.SetBounds(pad, DeskDraw.S(147) + extra, inner, DeskDraw.S(39));
                DirectoryCaption();
                logHeading.SetBounds(0, intake.Bottom + DeskDraw.S(24), width, DeskDraw.S(35));
                logTitle.SetBounds(0, DeskDraw.S(5), DeskDraw.S(68), DeskDraw.S(23));
                count.SetBounds(DeskDraw.S(77), DeskDraw.S(6), DeskDraw.S(70), DeskDraw.S(22));
                clearHistory.SetBounds(width - DeskDraw.S(80), 0, DeskDraw.S(80), DeskDraw.S(26));
                jobsPanel.Width = width;
                empty.Size = new Size(width, DeskDraw.S(114));
                foreach (var card in cards.Values) card.Width = width;
                int jobsHeight = empty.Visible ? empty.Height : cards.Values.Sum(card => card.Height);
                jobsPanel.SetBounds(0, logHeading.Bottom, width, Math.Max(1, jobsHeight));
                footer.SetBounds(0, jobsPanel.Bottom + DeskDraw.S(20), width, DeskDraw.S(diagnosticsOpen ? 224 : 59));
                privacy.SetBounds(0, 0, width, DeskDraw.S(23));
                diagnosticsButton.SetBounds(-DeskDraw.S(7), DeskDraw.S(24), DeskDraw.S(100), DeskDraw.S(26));
                reconnect.SetBounds(DeskDraw.S(110), DeskDraw.S(24), DeskDraw.S(90), DeskDraw.S(26));
                projectButton.SetBounds(width - DeskDraw.S(210), DeskDraw.S(24), DeskDraw.S(105), DeskDraw.S(26));
                extensionButton.SetBounds(width - DeskDraw.S(100), DeskDraw.S(24), DeskDraw.S(100), DeskDraw.S(26));
                diagnostics.SetBounds(0, DeskDraw.S(59), width, DeskDraw.S(158));
                diagnosticText.SetBounds(DeskDraw.S(12), DeskDraw.S(10), width - DeskDraw.S(24), DeskDraw.S(139));
                int height = footer.Bottom;
                if (content.Height != height) content.Height = height;
                viewport.AutoScrollMinSize = new Size(0, height + DeskDraw.S(64));
            }
            finally { arrangingView = false; }
        }
        private void DisposeDesktopView()
        {
            SystemEvents.UserPreferenceChanged -= SystemThemeChanged;
            tooltips.Dispose();
        }
    }
}
