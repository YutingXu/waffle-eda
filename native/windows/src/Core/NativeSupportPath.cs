using System;
using System.IO;

namespace Waffle.Windows
{
    static class NativeSupportPath
    {
        internal const string QualificationFlag = "WAFFLE_QUALIFICATION_PROFILE";

        internal static string Resolve(string localAppData, string temp, bool qualification)
        {
            if (!qualification) return Path.Combine(localAppData, "Waffle");
            var parent = new DirectoryInfo(Path.GetFullPath(temp));
            const string prefix = "waffle-preview-";
            if (!Path.IsPathRooted(temp) || !parent.Exists ||
                (parent.Attributes & FileAttributes.ReparsePoint) != 0 ||
                !parent.Name.StartsWith(prefix, StringComparison.Ordinal) ||
                !Guid.TryParseExact(parent.Name.Substring(prefix.Length), "N", out _))
                throw new ArgumentException("The qualification profile requires a fresh Waffle runner directory.", nameof(temp));
            var profile = Path.Combine(parent.FullName, "waffle-native-profile");
            if (File.Exists(profile) || Directory.Exists(profile))
                throw new ArgumentException("The qualification profile is already in use.", nameof(temp));
            return profile;
        }
    }
}
