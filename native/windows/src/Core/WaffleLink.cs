using System.Globalization;
using System.Text.RegularExpressions;

namespace Waffle.Windows
{
    // A URL activation supplies identities only. Paths still originate in a host picker or recents.
    static class WaffleLink
    {
        const string Id = "[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
        static readonly Regex Address = new Regex(@"\Awaffle://" + Id + "/" + Id +
            "(?:#datasheet:page=([1-9][0-9]{0,15}))?\\z", RegexOptions.CultureInvariant);

        static readonly Regex Identity = new Regex(@"\A" + Id + @"\z", RegexOptions.CultureInvariant);
        internal static bool ValidIdentity(string id) => id != null && id.Length == 36 && Identity.IsMatch(id);

        internal static string ProjectIdentity(string url) => Valid(url) ? url.Substring("waffle://".Length, 36) : null;

        internal static bool Valid(string url)
        {
            if (url == null || url.Length > 114) return false;
            var match = Address.Match(url);
            return match.Success && (!match.Groups[1].Success ||
                long.TryParse(match.Groups[1].Value, NumberStyles.None, CultureInfo.InvariantCulture, out var page) &&
                page <= 9007199254740991L);
        }
    }
}
