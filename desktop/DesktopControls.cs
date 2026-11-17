using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Globalization;
using System.Windows.Forms;

namespace VideoDownloaderApp
{
    internal sealed class DeskPalette
    {
        internal bool Dark;
        internal Color Paper, Panel, Field, Ink, Secondary, Muted, Rule, StrongRule, Tick, TickOn, Good, Bad;
        internal Color[] Bars;
        internal static DeskPalette Create(bool dark)
        {
            return dark ? new DeskPalette {
                Dark = true, Paper = C("0F1114"), Panel = C("181B1F"), Field = C("1F2328"), Ink = C("E9ECEF"),
                Secondary = C("A3ABB4"), Muted = C("6B737C"), Rule = C("272B30"), StrongRule = C("3A4046"),
                Tick = C("2F353B"), TickOn = C("C9D1D8"), Good = C("3FBF7F"), Bad = C("F2695A"),
                Bars = new[] { C("2ACBD9"), C("F0C63F"), C("DC5CA2"), C("4E7BF0") }
            } : new DeskPalette {
                Paper = C("ECEEF0"), Panel = Color.White, Field = C("F6F7F8"), Ink = C("16191D"),
                Secondary = C("4D555E"), Muted = C("848C95"), Rule = C("DCE0E4"), StrongRule = C("C6CCD2"),
                Tick = C("C8CED4"), TickOn = C("16191D"), Good = C("0F7A4A"), Bad = C("B4291B"),
                Bars = new[] { C("19B6C4"), C("E4B829"), C("C53C8C"), C("2D5BD1") }
            };
        }
        private static Color C(string hex) { return ColorTranslator.FromHtml("#" + hex); }
        internal static Color Blend(Color background, Color foreground, float amount)
        {
            return Color.FromArgb((int)(background.R * (1 - amount) + foreground.R * amount),
                (int)(background.G * (1 - amount) + foreground.G * amount), (int)(background.B * (1 - amount) + foreground.B * amount));
        }
    }

    internal static class DeskDraw
    {
        internal static float Scale = 1;
        internal static int S(int value) { return (int)Math.Round(value * Scale); }
        internal static GraphicsPath Round(RectangleF rectangle, float radius)
        {
            float diameter = Math.Max(1, Math.Min(radius * 2, Math.Min(rectangle.Width, rectangle.Height)));
            var path = new GraphicsPath();
            path.AddArc(rectangle.Left, rectangle.Top, diameter, diameter, 180, 90);
            path.AddArc(rectangle.Right - diameter, rectangle.Top, diameter, diameter, 270, 90);
            path.AddArc(rectangle.Right - diameter, rectangle.Bottom - diameter, diameter, diameter, 0, 90);
            path.AddArc(rectangle.Left, rectangle.Bottom - diameter, diameter, diameter, 90, 90);
            path.CloseFigure(); return path;
        }
    }

    internal sealed class DeskButton : Button
    {
        internal DeskPalette Palette = DeskPalette.Create(false);
        internal bool Primary, Quiet;
        private bool hover;
        internal DeskButton()
        {
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
            FlatStyle = FlatStyle.Flat; FlatAppearance.BorderSize = 0; Cursor = Cursors.Hand;
            Font = new Font("Microsoft YaHei UI", 9F);
        }
        protected override void OnMouseEnter(EventArgs e) { hover = true; Invalidate(); base.OnMouseEnter(e); }
        protected override void OnMouseLeave(EventArgs e) { hover = false; Invalidate(); base.OnMouseLeave(e); }
        protected override void OnPaint(PaintEventArgs e)
        {
            var p = Palette;
            e.Graphics.Clear(Parent == null ? p.Paper : Parent.BackColor);
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            Color fill = Quiet ? p.Paper : Primary ? p.Ink : p.Panel;
            if (hover && Enabled) fill = Primary ? DeskPalette.Blend(p.Ink, p.Panel, .12F) : p.Field;
            if (!Enabled) fill = DeskPalette.Blend(Quiet ? p.Paper : p.Panel, fill, .4F);
            using (var shape = DeskDraw.Round(new RectangleF(.5F, .5F, Math.Max(1, Width - 1), Math.Max(1, Height - 1)), DeskDraw.S(7)))
            using (var brush = new SolidBrush(fill))
            using (var pen = new Pen(Quiet ? p.Paper : Primary ? fill : hover ? p.Muted : p.StrongRule))
            { e.Graphics.FillPath(brush, shape); if (!Quiet) e.Graphics.DrawPath(pen, shape); }
            Color ink = Primary ? p.Panel : p.Ink;
            if (!Enabled) ink = p.Muted;
            TextRenderer.DrawText(e.Graphics, Text, Font, ClientRectangle, ink, TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.SingleLine | TextFormatFlags.NoPrefix);
            if (Focused && ShowFocusCues)
            {
                using (var pen = new Pen(p.Bars[3], DeskDraw.S(1)))
                    e.Graphics.DrawRectangle(pen, DeskDraw.S(3), DeskDraw.S(3), Math.Max(1, Width - DeskDraw.S(7)), Math.Max(1, Height - DeskDraw.S(7)));
            }
        }
    }

    internal sealed class DeskPanel : Panel
    {
        internal DeskPalette Palette = DeskPalette.Create(false);
        internal bool Field, FocusedField;
        internal DeskPanel() { DoubleBuffered = true; ResizeRedraw = true; }
        protected override void OnPaintBackground(PaintEventArgs e)
        {
            e.Graphics.Clear(Parent == null ? Palette.Paper : Parent.BackColor);
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            using (var shape = DeskDraw.Round(new RectangleF(.5F, .5F, Math.Max(1, Width - 1), Math.Max(1, Height - 1)), DeskDraw.S(Field ? 8 : 11)))
            using (var fill = new SolidBrush(Field ? Palette.Field : Palette.Panel))
            using (var pen = new Pen(FocusedField ? Palette.Secondary : Palette.Rule))
            { e.Graphics.FillPath(fill, shape); e.Graphics.DrawPath(pen, shape); }
        }
    }

    internal sealed class DeskSelect : Control
    {
        internal readonly List<object> Items = new List<object>();
        internal DeskPalette Palette = DeskPalette.Create(false);
        internal event EventHandler SelectedIndexChanged;
        private int index = -1;
        private ContextMenuStrip menu;
        internal DeskSelect()
        {
            SetStyle(ControlStyles.Selectable | ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
            TabStop = true; Cursor = Cursors.Hand; AccessibleRole = AccessibleRole.ComboBox;
        }
        internal int SelectedIndex
        {
            get { return index; }
            set
            {
                if (value < 0 || value >= Items.Count || value == index) return;
                index = value; Text = Convert.ToString(Items[index]); Invalidate();
                if (IsHandleCreated) AccessibilityNotifyClients(AccessibleEvents.ValueChange, -1);
                if (SelectedIndexChanged != null) SelectedIndexChanged(this, EventArgs.Empty);
            }
        }
        protected override void OnClick(EventArgs e) { base.OnClick(e); Focus(); OpenMenu(); }
        protected override bool IsInputKey(Keys keyData)
        {
            var key = keyData & Keys.KeyCode;
            return key == Keys.Up || key == Keys.Down || key == Keys.Home || key == Keys.End || base.IsInputKey(keyData);
        }
        protected override void OnKeyDown(KeyEventArgs e)
        {
            if (e.KeyCode == Keys.Space || e.KeyCode == Keys.Enter || (e.Alt && e.KeyCode == Keys.Down)) { OpenMenu(); e.Handled = true; }
            else if (e.KeyCode == Keys.Home) { SelectedIndex = 0; e.Handled = true; }
            else if (e.KeyCode == Keys.End) { SelectedIndex = Items.Count - 1; e.Handled = true; }
            else if (e.KeyCode == Keys.Down) { SelectedIndex = Math.Min(Items.Count - 1, index + 1); e.Handled = true; }
            else if (e.KeyCode == Keys.Up) { SelectedIndex = Math.Max(0, index - 1); e.Handled = true; }
            base.OnKeyDown(e);
        }
        private void OpenMenu()
        {
            if (!Enabled || Items.Count == 0) return;
            if (menu != null) menu.Dispose();
            menu = new ContextMenuStrip { Font = Font, BackColor = Palette.Panel, ForeColor = Palette.Ink, ShowImageMargin = false,
                ShowCheckMargin = false, Renderer = new ToolStripProfessionalRenderer(new MenuColors(Palette)) };
            for (int i = 0; i < Items.Count; i++)
            {
                int selected = i;
                var item = new ToolStripMenuItem(Convert.ToString(Items[i]) + (i == index ? "  ✓" : ""))
                    { AutoSize = false, Width = Math.Max(Width, DeskDraw.S(145)), Height = DeskDraw.S(31), BackColor = Palette.Panel, ForeColor = Palette.Ink };
                item.Click += delegate { SelectedIndex = selected; menu.Close(); };
                menu.Items.Add(item);
            }
            menu.Show(this, new Point(0, Height + DeskDraw.S(2)));
        }
        protected override void OnEnabledChanged(EventArgs e) { base.OnEnabledChanged(e); if (!Enabled && menu != null) menu.Close(); Invalidate(); }
        protected override void OnGotFocus(EventArgs e) { base.OnGotFocus(e); Invalidate(); }
        protected override void OnLostFocus(EventArgs e) { base.OnLostFocus(e); Invalidate(); }
        protected override void OnPaint(PaintEventArgs e)
        {
            var p = Palette; e.Graphics.Clear(Parent == null ? p.Panel : Parent.BackColor); e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            using (var shape = DeskDraw.Round(new RectangleF(.5F, .5F, Width - 1, Height - 1), DeskDraw.S(7)))
            using (var fill = new SolidBrush(p.Panel))
            using (var pen = new Pen(Focused && ShowFocusCues ? p.Bars[3] : p.StrongRule))
            { e.Graphics.FillPath(fill, shape); e.Graphics.DrawPath(pen, shape); }
            TextRenderer.DrawText(e.Graphics, Text, Font, new Rectangle(DeskDraw.S(9), 0, Width - DeskDraw.S(31), Height),
                Enabled ? p.Ink : p.Muted, TextFormatFlags.VerticalCenter | TextFormatFlags.SingleLine | TextFormatFlags.NoPrefix | TextFormatFlags.EndEllipsis);
            int x = Width - DeskDraw.S(17), y = Height / 2;
            using (var pen = new Pen(p.Secondary, Math.Max(1, DeskDraw.Scale))) e.Graphics.DrawLines(pen,
                new[] { new Point(x, y - DeskDraw.S(2)), new Point(x + DeskDraw.S(4), y + DeskDraw.S(2)), new Point(x + DeskDraw.S(8), y - DeskDraw.S(2)) });
        }
        protected override AccessibleObject CreateAccessibilityInstance() { return new SelectAccessibility(this); }
        private sealed class SelectAccessibility : ControlAccessibleObject
        {
            private readonly DeskSelect select;
            internal SelectAccessibility(DeskSelect owner) : base(owner) { select = owner; }
            public override string Value { get { return select.Text; } set { for (int i = 0; i < select.Items.Count; i++) if (Convert.ToString(select.Items[i]) == value) { select.SelectedIndex = i; break; } } }
            public override string DefaultAction { get { return "打开"; } }
            public override void DoDefaultAction() { select.OpenMenu(); }
        }
        private sealed class MenuColors : ProfessionalColorTable
        {
            private readonly DeskPalette p;
            internal MenuColors(DeskPalette palette) { p = palette; UseSystemColors = false; }
            public override Color ToolStripDropDownBackground { get { return p.Panel; } }
            public override Color MenuItemSelected { get { return p.Field; } }
            public override Color MenuItemBorder { get { return p.Rule; } }
            public override Color MenuBorder { get { return p.StrongRule; } }
        }
        protected override void Dispose(bool disposing) { if (disposing && menu != null) menu.Dispose(); base.Dispose(disposing); }
    }

    internal sealed class DeskBar : Control
    {
        internal DeskPalette Palette = DeskPalette.Create(false);
        internal DeskBar() { DoubleBuffered = true; }
        protected override void OnPaint(PaintEventArgs e)
        {
            for (int i = 0; i < 4; i++) using (var brush = new SolidBrush(Palette.Bars[i]))
                e.Graphics.FillRectangle(brush, Width * i / 4, 0, Width * (i + 1) / 4 - Width * i / 4, Height);
        }
    }

    internal sealed class StatusDot : Control
    {
        internal Color DotColor = Color.Gray;
        internal StatusDot() { DoubleBuffered = true; }
        protected override void OnPaint(PaintEventArgs e)
        {
            e.Graphics.Clear(BackColor); e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            int size = DeskDraw.S(6);
            using (var brush = new SolidBrush(DotColor)) e.Graphics.FillEllipse(brush, (Width - size) / 2, (Height - size) / 2, size, size);
        }
    }

    internal sealed class TickMeter : Control
    {
        internal DeskPalette Palette = DeskPalette.Create(false);
        internal double Progress { get; set; }
        private bool waiting;
        private int position;
        private readonly Timer animation = new Timer { Interval = 45 };
        internal TickMeter()
        {
            DoubleBuffered = true; ResizeRedraw = true;
            AccessibleRole = AccessibleRole.ProgressBar; AccessibleName = "下载进度";
            animation.Tick += delegate { position = (position + DeskDraw.S(5)) % Math.Max(1, Width + DeskDraw.S(48)); Invalidate(); };
        }
        internal bool Waiting
        {
            get { return waiting; }
            set { waiting = value; animation.Enabled = value && Visible; Invalidate(); }
        }
        protected override void OnVisibleChanged(EventArgs e) { base.OnVisibleChanged(e); animation.Enabled = waiting && Visible; }
        protected override AccessibleObject CreateAccessibilityInstance() { return new MeterAccessibility(this); }
        private sealed class MeterAccessibility : ControlAccessibleObject
        {
            private readonly TickMeter meter;
            internal MeterAccessibility(TickMeter owner) : base(owner) { meter = owner; }
            public override string Value { get { return meter.Waiting ? "正在获取视频信息" : meter.Progress.ToString("0.0", CultureInfo.InvariantCulture) + "%"; } set { } }
        }
        protected override void OnPaint(PaintEventArgs e)
        {
            e.Graphics.Clear(BackColor);
            int filled = (int)(Width * Math.Max(0, Math.Min(100, Progress)) / 100);
            int step = Math.Max(2, DeskDraw.S(4)); int tick = Math.Max(1, DeskDraw.S(2));
            using (var off = new SolidBrush(Palette.Tick))
            using (var on = new SolidBrush(Palette.TickOn))
            using (var moving = new SolidBrush(Palette.Muted))
            {
                for (int x = 0; x < Width; x += step)
                {
                    bool sweep = waiting && x >= position - DeskDraw.S(48) && x < position;
                    e.Graphics.FillRectangle(sweep ? moving : x < filled ? on : off, x, 0, tick, Height);
                }
            }
        }
        protected override void Dispose(bool disposing) { if (disposing) animation.Dispose(); base.Dispose(disposing); }
    }

    internal sealed class EmptyState : Control
    {
        internal DeskPalette Palette = DeskPalette.Create(false);
        internal EmptyState() { DoubleBuffered = true; AccessibleName = "还没有下载记录，贴一个视频链接试试"; AccessibleRole = AccessibleRole.StaticText; }
        protected override void OnPaint(PaintEventArgs e)
        {
            e.Graphics.Clear(Palette.Paper);
            using (var heading = new Font("Microsoft YaHei UI", 9.5F, FontStyle.Bold))
            using (var body = new Font("Microsoft YaHei UI", 9F))
            using (var pen = new Pen(Palette.Rule))
            {
                TextRenderer.DrawText(e.Graphics, "还没有下载记录", heading, new Point(DeskDraw.S(2), DeskDraw.S(30)), Palette.Secondary, TextFormatFlags.NoPadding);
                TextRenderer.DrawText(e.Graphics, "贴一个视频链接，点开始下载，文件会出现在上面的保存位置里。", body,
                    new Rectangle(DeskDraw.S(2), DeskDraw.S(56), Width - DeskDraw.S(4), DeskDraw.S(44)), Palette.Muted, TextFormatFlags.WordBreak | TextFormatFlags.NoPadding);
                e.Graphics.DrawLine(pen, 0, Height - 1, Width, Height - 1);
            }
        }
    }

    internal sealed class JobCard : Panel
    {
        private readonly Label title = new Label(), detail = new Label(), state = new Label(), numbers = new Label(), error = new Label();
        private readonly Panel errorBox = new Panel();
        private readonly TickMeter meter = new TickMeter();
        private readonly DeskButton action = new DeskButton();
        private string currentAction, status = "running";
        private DeskPalette palette;
        private bool arranging;
        internal event Action<string> ActionClicked;
        internal JobCard(DeskPalette theme)
        {
            DoubleBuffered = true; ResizeRedraw = true; Width = DeskDraw.S(700); Margin = Padding.Empty;
            title.Font = new Font("Microsoft YaHei UI", 9.5F, FontStyle.Bold); title.AutoEllipsis = true;
            detail.Font = new Font("Consolas", 8.5F); detail.TextAlign = ContentAlignment.MiddleRight; detail.AutoEllipsis = true;
            state.Font = new Font("Microsoft YaHei UI", 9F); state.AutoEllipsis = true;
            numbers.Font = new Font("Consolas", 9F); numbers.TextAlign = ContentAlignment.MiddleRight;
            action.Font = new Font("Microsoft YaHei UI", 8.5F); action.Height = DeskDraw.S(26); action.Width = DeskDraw.S(84);
            error.Font = new Font("Microsoft YaHei UI", 8.5F); error.AutoEllipsis = true;
            errorBox.Controls.Add(error);
            errorBox.Paint += delegate(object sender, PaintEventArgs e) { using (var brush = new SolidBrush(palette.Bad)) e.Graphics.FillRectangle(brush, 0, 0, DeskDraw.S(2), errorBox.Height); };
            Controls.AddRange(new Control[] { title, detail, meter, state, numbers, action, errorBox });
            action.Click += delegate { if (ActionClicked != null) ActionClicked(currentAction); };
            SetPalette(theme);
        }
        internal void SetPalette(DeskPalette theme)
        {
            palette = theme; BackColor = theme.Paper; title.ForeColor = theme.Ink; detail.ForeColor = theme.Muted;
            numbers.ForeColor = theme.Secondary; meter.Palette = theme; meter.BackColor = theme.Paper;
            action.Palette = theme; action.BackColor = theme.Paper;
            errorBox.BackColor = DeskPalette.Blend(theme.Paper, theme.Bad, theme.Dark ? .08F : .055F);
            error.BackColor = errorBox.BackColor; error.ForeColor = theme.Bad;
            state.ForeColor = status == "done" ? theme.Good : status == "error" ? theme.Bad : theme.Secondary;
            Invalidate(true);
        }
        internal void UpdateJob(Dictionary<string, object> job)
        {
            title.Text = MainForm.Str(job, "name");
            string quality = MainForm.Str(job, "quality");
            string spec = quality == "2160p" ? "4K 优先" : quality == "1080p" ? "1080p 优先" : quality == "720p" ? "720p 优先" : "自动最佳";
            object source; if (job.TryGetValue("sourceQuality", out source) && source is bool && (bool)source) spec = "原站画质";
            if (MainForm.Num(job, "width") > 0 && MainForm.Num(job, "height") > 0) spec += "  " + MainForm.Str(job, "width") + "×" + MainForm.Str(job, "height");
            detail.Text = spec;
            status = MainForm.Str(job, "status");
            double progress = MainForm.Num(job, "pct");
            meter.Progress = progress; meter.Visible = status == "running"; meter.Waiting = status == "running" && progress <= 0; meter.Invalidate();
            string note = MainForm.Str(job, "note");
            state.Text = status == "done" ? "已保存" + (note.Length == 0 ? "" : "　" + note) : status == "error" ? "下载失败" : MainForm.Str(job, "phase");
            state.ForeColor = status == "done" ? palette.Good : status == "error" ? palette.Bad : palette.Secondary;
            string eta = MainForm.Str(job, "eta");
            string speed = MainForm.Str(job, "speed");
            if (String.Equals(speed, "Unknown", StringComparison.OrdinalIgnoreCase) || speed == "NA") speed = "";
            numbers.Text = progress.ToString("0.0", CultureInfo.InvariantCulture) + "%" + (speed.Length == 0 ? "" : "  " + speed) + (eta.Length == 0 || eta == "Unknown" ? "" : "  " + eta);
            numbers.Visible = status == "running" && progress > 0;
            currentAction = status == "error" ? "retry" : "reveal";
            action.Visible = status == "done" || status == "error"; action.Text = status == "error" ? "再试一次" : "打开位置";
            error.Text = MainForm.Str(job, "err"); errorBox.Visible = status == "error" && error.Text.Length > 0;
            Arrange();
        }
        protected override void OnSizeChanged(EventArgs e) { base.OnSizeChanged(e); if (palette != null) Arrange(); }
        private void Arrange()
        {
            if (arranging) return; arranging = true;
            try
            {
                int pad = DeskDraw.S(2), width = Math.Max(1, Width - pad * 2);
                int specWidth = Math.Min(DeskDraw.S(252), TextRenderer.MeasureText(detail.Text, detail.Font).Width + DeskDraw.S(4));
                title.SetBounds(pad, DeskDraw.S(13), Math.Max(20, width - specWidth - DeskDraw.S(14)), DeskDraw.S(23));
                detail.SetBounds(Width - pad - specWidth, DeskDraw.S(13), specWidth, DeskDraw.S(23));
                meter.SetBounds(pad, DeskDraw.S(45), width, DeskDraw.S(13));
                int bottom = status == "running" ? DeskDraw.S(67) : DeskDraw.S(40);
                int rightWidth = action.Visible ? DeskDraw.S(88) : numbers.Visible ? Math.Min(DeskDraw.S(310), TextRenderer.MeasureText(numbers.Text, numbers.Font).Width + DeskDraw.S(4)) : 0;
                state.SetBounds(pad, bottom, Math.Max(20, width - rightWidth - DeskDraw.S(12)), DeskDraw.S(26));
                numbers.SetBounds(Width - pad - rightWidth, bottom, rightWidth, DeskDraw.S(26));
                action.SetBounds(Width - pad - DeskDraw.S(84), bottom, DeskDraw.S(84), DeskDraw.S(26));
                int height = bottom + DeskDraw.S(39);
                if (errorBox.Visible)
                {
                    int errorHeight = Math.Min(DeskDraw.S(160), Math.Max(DeskDraw.S(32), TextRenderer.MeasureText(error.Text, error.Font,
                        new Size(Math.Max(20, width - DeskDraw.S(24)), Int32.MaxValue), TextFormatFlags.WordBreak).Height + DeskDraw.S(16)));
                    errorBox.SetBounds(pad, bottom + DeskDraw.S(35), width, errorHeight);
                    error.SetBounds(DeskDraw.S(12), DeskDraw.S(7), width - DeskDraw.S(24), errorHeight - DeskDraw.S(12));
                    height = errorBox.Bottom + DeskDraw.S(14);
                }
                Height = height;
            }
            finally { arranging = false; }
        }
        protected override void OnPaint(PaintEventArgs e) { base.OnPaint(e); using (var pen = new Pen(palette.Rule)) e.Graphics.DrawLine(pen, 0, Height - 1, Width, Height - 1); }
    }
}
