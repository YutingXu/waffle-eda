// Small native dialogs for the page's alert/confirm/prompt and the close confirmation.
// WinForms on .NET Framework has no TaskDialog, so this is one DPI-scaled form.
using System;
using System.Drawing;
using System.Windows.Forms;

namespace Waffle.Windows
{
    static class Dialogs
    {
        /// True when the accept button was chosen. cancel == null shows a single button.
        public static bool Ask(IWin32Window owner, string message, string detail, string accept, string cancel, bool acceptIsDefault = true)
        {
            string ignored;
            var labels = cancel == null ? new[] { accept } : new[] { accept, cancel };
            int no = cancel == null ? 0 : 1;
            return Show(owner, message, detail, labels, acceptIsDefault ? 0 : no, no, null, out ignored) == 0;
        }

        /// The text entered, or null when cancelled.
        public static string Prompt(IWin32Window owner, string message, string initial)
        {
            string text;
            return Show(owner, message, null, new[] { "OK", "Cancel" }, 0, 1, initial ?? "", out text) == 0 ? text : null;
        }

        /// Closing with unsaved changes, as Windows apps ask: Save (default, Enter), Don't Save, Cancel (Esc).
        public static CloseChoice AskToSave(IWin32Window owner, string projectName)
        {
            string ignored;
            switch (Show(owner, Host.SavePrompt(projectName), null, new[] { "&Save", "Do&n't Save", "Cancel" }, 0, 2, null, out ignored))
            {
                case 0: return CloseChoice.Save;
                case 1: return CloseChoice.DontSave;
                default: return CloseChoice.Cancel;
            }
        }

        /// The index of the chosen button (left to right); the cancel index for Esc or the title bar's close.
        public static int Show(IWin32Window owner, string message, string detail, string[] labels, int accept, int cancel,
                        string input, out string text, Action<Form> presented = null)
        {
            using (var form = new Form())
            {
                form.Text = "Waffle";
                form.FormBorderStyle = FormBorderStyle.FixedDialog;
                form.MinimizeBox = form.MaximizeBox = false;
                form.ShowInTaskbar = false;
                form.StartPosition = FormStartPosition.CenterParent;
                form.AutoScaleMode = AutoScaleMode.Dpi;
                form.Font = SystemFonts.MessageBoxFont;
                form.AutoSize = true;
                form.AutoSizeMode = AutoSizeMode.GrowAndShrink;
                var layout = new TableLayoutPanel { AutoSize = true, ColumnCount = 1, Padding = new Padding(16), Dock = DockStyle.Fill };
                layout.Controls.Add(new Label { Text = message ?? "", AutoSize = true, MaximumSize = new Size(440, 0), Font = new Font(form.Font, FontStyle.Bold), Margin = new Padding(0, 0, 0, 8) });
                if (!string.IsNullOrEmpty(detail)) layout.Controls.Add(new Label { Text = detail, AutoSize = true, MaximumSize = new Size(440, 0), Margin = new Padding(0, 0, 0, 8) });
                TextBox box = null;
                if (input != null) { box = new TextBox { Text = input, Width = 360, Margin = new Padding(0, 0, 0, 8) }; layout.Controls.Add(box); }
                var buttons = new FlowLayoutPanel { FlowDirection = FlowDirection.RightToLeft, AutoSize = true, Dock = DockStyle.Fill, Margin = new Padding(0, 8, 0, 0) };
                int chosen = cancel;
                var made = new Button[labels.Length];
                for (int i = 0; i < labels.Length; i++)
                {
                    int index = i;
                    made[i] = new Button { Text = labels[i], AutoSize = true, MinimumSize = new Size(88, 0) };
                    made[i].Click += (s, e) => { chosen = index; form.DialogResult = DialogResult.OK; };
                }
                // Windows order: left to right as listed (the accept button first, Cancel last), right-aligned.
                for (int i = labels.Length - 1; i >= 0; i--) buttons.Controls.Add(made[i]);
                layout.Controls.Add(buttons);
                form.Controls.Add(layout);
                form.AcceptButton = made[accept];
                form.CancelButton = made[cancel];
                form.Shown += (s, e) => { presented?.Invoke(form); if (box != null) { box.Focus(); box.SelectAll(); } else made[accept].Focus(); };
                if (form.ShowDialog(owner) != DialogResult.OK) chosen = cancel;
                text = box?.Text;
                return chosen;
            }
        }
    }
}
