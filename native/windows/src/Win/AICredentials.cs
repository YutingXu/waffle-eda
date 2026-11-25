using System;
using System.Collections.Generic;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;

namespace Waffle.Windows
{
    static class AICredentials
    {
        const int Generic = 1, LocalMachine = 2, NotFound = 1168, MaxBytes = 2560;
        const string Prefix = "org.waffle.editor.ai-provider/";
        static readonly UTF8Encoding Utf8 = new UTF8Encoding(false, true);

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        struct Entry
        {
            public int Flags, Type;
            public string TargetName, Comment;
            public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
            public int CredentialBlobSize;
            public IntPtr CredentialBlob;
            public int Persist, AttributeCount;
            public IntPtr Attributes;
            public string TargetAlias, UserName;
        }

        [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern bool Read(string target, int type, int flags, out IntPtr result);
        [DllImport("advapi32.dll", EntryPoint = "CredWriteW", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern bool Write(ref Entry entry, int flags);
        [DllImport("advapi32.dll", EntryPoint = "CredDeleteW", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern bool Delete(string target, int type, int flags);
        [DllImport("advapi32.dll", EntryPoint = "CredFree")]
        static extern void Free(IntPtr value);

        static object ReadSecret(string name, bool status)
        {
            if (!Read(name, Generic, 0, out var pointer))
            {
                if (Marshal.GetLastWin32Error() == NotFound) return status ? Configured(false) : null;
                throw new HostError("The system credential manager is unavailable.");
            }
            try
            {
                var value = Marshal.PtrToStructure<Entry>(pointer);
                if (value.CredentialBlobSize <= 0 || value.CredentialBlobSize > MaxBytes)
                    throw new HostError("The stored provider credential is invalid.");
                if (status) return Configured(true);
                var bytes = new byte[value.CredentialBlobSize];
                try { Marshal.Copy(value.CredentialBlob, bytes, 0, bytes.Length); return Utf8.GetString(bytes); }
                finally { Array.Clear(bytes, 0, bytes.Length); }
            }
            finally { Free(pointer); }
        }

        static void Store(string name, string value)
        {
            if (string.IsNullOrEmpty(value) || Utf8.GetByteCount(value) > MaxBytes || value.Any(char.IsControl))
                throw new HostError("Enter a single provider credential of at most 2560 bytes.");
            var bytes = Utf8.GetBytes(value);
            var blob = Marshal.AllocHGlobal(bytes.Length);
            try
            {
                Marshal.Copy(bytes, 0, blob, bytes.Length);
                var entry = new Entry {Type = Generic, TargetName = name, UserName = "Waffle", CredentialBlobSize = bytes.Length,
                    CredentialBlob = blob, Persist = LocalMachine };
                if (!Write(ref entry, 0)) throw new HostError("The credential could not be stored in Credential Manager.");
            }
            finally
            {
                Array.Clear(bytes, 0, bytes.Length);
                Marshal.Copy(bytes, 0, blob, bytes.Length);
                Marshal.FreeHGlobal(blob);
            }
        }

        static Dictionary<string, object> Configured(bool value) => new Dictionary<string, object> { ["available"] = true, ["configured"] = value, ["maxBytes"] = MaxBytes };

        internal static object Request(IWin32Window owner, string operation, string provider)
        {
            string name = Prefix + provider;
            string labelText = provider.Substring(0, provider.LastIndexOf(':'));
            if (operation == "load" || operation == "status") return ReadSecret(name, operation == "status");
            if (operation == "forget")
            {
                if (MessageBox.Show(owner, labelText, "Remove provider credential?", MessageBoxButtons.OKCancel,
                    MessageBoxIcon.Question) != DialogResult.OK) return new Dictionary<string, object> { ["cancelled"] = true };
                if (!Delete(name, Generic, 0) && Marshal.GetLastWin32Error() != NotFound)
                    throw new HostError("The credential could not be removed from Credential Manager.");
                return Configured(false);
            }
            using (var prompt = new Form {Text = "Store provider credential", FormBorderStyle = FormBorderStyle.FixedDialog,
                       StartPosition = FormStartPosition.CenterParent, MinimizeBox = false, MaximizeBox = false,
                       ShowInTaskbar = false, Width = 380, Height = 152})
            using (var field = new TextBox {Left = 16, Top = 32, Width = 332, UseSystemPasswordChar = true, MaxLength = MaxBytes})
            using (var save = new Button {Text = "Store", Left = 190, Top = 68, DialogResult = DialogResult.OK})
            using (var cancel = new Button {Text = "Cancel", Left = 273, Top = 68, DialogResult = DialogResult.Cancel})
            using (var label = new Label {Text = labelText, Left = 16, Top = 10, Width = 332})
            {
                prompt.Controls.AddRange(new Control[] {label, field, save, cancel});
                prompt.AcceptButton = save;
                prompt.CancelButton = cancel;
                prompt.ActiveControl = field;
                if (prompt.ShowDialog(owner) != DialogResult.OK)
                    return new Dictionary<string, object> { ["cancelled"] = true };
                try { Store(name, field.Text); return Configured(true); }
                finally { field.Clear(); }
            }
        }
    }
}
