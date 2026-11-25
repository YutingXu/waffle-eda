// Minimal JSON for the bridge and the host's own lists. Objects parse to
// Dictionary<string, object> (ordinal keys), arrays to List<object>, numbers to double.
// No dependencies, so the .NET Framework host ships no serializer assemblies.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Text;

namespace Waffle.Windows
{
    public sealed class JsonException : Exception
    {
        public JsonException(string message) : base(message) { }
    }

    public static class Json
    {
        const int MaxDepth = 64;

        public static object Parse(string text) => Parse(text, null, false);

        // Native folder comparisons retain exact property tokens alongside parsed values.
        // The general bridge preserves its established JSON parsing behavior.
        internal static object ParseStrict(string text, Dictionary<string, string> propertyTokens = null) => Parse(text, propertyTokens, true);

        // The bounded native header is an envelope. Optional numbers that cannot
        // be represented as Double remain on disk and are never used by its policy.
        internal static object ParseHeader(string text) => Parse(text, null, true, nativeHeader: true);

        static object Parse(string text, Dictionary<string, string> propertyTokens, bool strict, bool nativeHeader = false)
        {
            if (text == null) throw new JsonException("No JSON.");
            var p = new Parser(text, propertyTokens, strict, nativeHeader);
            p.Space();
            var value = p.Value(0);
            p.Space();
            if (p.At < text.Length) throw new JsonException("Unexpected text after JSON.");
            return value;
        }

        sealed class Parser
        {
            readonly string s;
            public int At;
            readonly Dictionary<string, string> propertyTokens;
            readonly bool strict, nativeHeader;
            public Parser(string text, Dictionary<string, string> propertyTokens, bool strict, bool nativeHeader)
            { s = text; this.propertyTokens = propertyTokens; this.strict = strict; this.nativeHeader = nativeHeader; }

            public void Space()
            {
                while (At < s.Length && (s[At] == ' ' || s[At] == '\t' || s[At] == '\n' || s[At] == '\r')) At++;
            }

            char Next() { if (At >= s.Length) throw new JsonException("Unexpected end of JSON."); return s[At++]; }

            public object Value(int depth)
            {
                if (depth > (nativeHeader ? 512 : MaxDepth)) throw new JsonException("JSON is nested too deeply.");
                if (At >= s.Length) throw new JsonException("Unexpected end of JSON.");
                char c = s[At];
                switch (c)
                {
                    case '{': return Obj(depth);
                    case '[': return Arr(depth);
                    case '"': return Str();
                    case 't': Word("true"); return true;
                    case 'f': Word("false"); return false;
                    case 'n': Word("null"); return null;
                    default:
                        if (c == '-' || (c >= '0' && c <= '9')) return Num();
                        throw new JsonException("Unexpected character in JSON.");
                }
            }

            void Word(string w)
            {
                if (string.CompareOrdinal(s, At, w, 0, w.Length) != 0) throw new JsonException("Unexpected word in JSON.");
                At += w.Length;
            }

            Dictionary<string, object> Obj(int depth)
            {
                var d = new Dictionary<string, object>(StringComparer.Ordinal);
                At++;
                Space();
                if (At < s.Length && s[At] == '}') { At++; return d; }
                while (true)
                {
                    Space();
                    if (At >= s.Length || s[At] != '"') throw new JsonException("Expected a property name.");
                    int start = At;
                    var key = Str();
                    if (strict && d.ContainsKey(key)) throw new JsonException("Duplicate JSON property.");
                    Space();
                    if (Next() != ':') throw new JsonException("Expected ':'.");
                    Space();
                    d[key] = Value(depth + 1);
                    if (depth == 0 && propertyTokens != null) propertyTokens.Add(key, s.Substring(start, At - start));
                    Space();
                    char c = Next();
                    if (c == '}') return d;
                    if (c != ',') throw new JsonException("Expected ',' or '}'.");
                }
            }

            List<object> Arr(int depth)
            {
                var list = new List<object>();
                At++;
                Space();
                if (At < s.Length && s[At] == ']') { At++; return list; }
                while (true)
                {
                    Space();
                    list.Add(Value(depth + 1));
                    Space();
                    char c = Next();
                    if (c == ']') return list;
                    if (c != ',') throw new JsonException("Expected ',' or ']'.");
                }
            }

            string Str()
            {
                At++; // opening quote
                int start = At;
                // Fast path: no escapes.
                while (At < s.Length && s[At] != '"' && s[At] != '\\')
                {
                    if (s[At] < 0x20) throw new JsonException("Control character in JSON string.");
                    At++;
                }
                if (At < s.Length && s[At] == '"') { At++; return s.Substring(start, At - 1 - start); }
                var b = new StringBuilder(s, start, At - start, Math.Max(16, At - start + 16));
                while (true)
                {
                    char c = Next();
                    if (c == '"') return b.ToString();
                    if (c < 0x20) throw new JsonException("Control character in JSON string.");
                    if (c != '\\') { b.Append(c); continue; }
                    char e = Next();
                    switch (e)
                    {
                        case '"': b.Append('"'); break;
                        case '\\': b.Append('\\'); break;
                        case '/': b.Append('/'); break;
                        case 'b': b.Append('\b'); break;
                        case 'f': b.Append('\f'); break;
                        case 'n': b.Append('\n'); break;
                        case 'r': b.Append('\r'); break;
                        case 't': b.Append('\t'); break;
                        case 'u':
                            if (At + 4 > s.Length) throw new JsonException("Bad unicode escape.");
                            int code;
                            if (!int.TryParse(s.Substring(At, 4), NumberStyles.AllowHexSpecifier, CultureInfo.InvariantCulture, out code))
                                throw new JsonException("Bad unicode escape.");
                            At += 4;
                            b.Append((char)code);
                            break;
                        default: throw new JsonException("Bad escape in JSON string.");
                    }
                }
            }

            double Num()
            {
                int start = At;
                if (s[At] == '-') At++;
                if (At >= s.Length) throw new JsonException("Bad number.");
                if (s[At] == '0') At++;
                else if (s[At] >= '1' && s[At] <= '9') while (At < s.Length && char.IsDigit(s[At]) && s[At] < 128) At++;
                else throw new JsonException("Bad number.");
                if (At < s.Length && s[At] == '.')
                {
                    At++;
                    int digits = At;
                    while (At < s.Length && s[At] >= '0' && s[At] <= '9') At++;
                    if (At == digits) throw new JsonException("Bad number.");
                }
                if (At < s.Length && (s[At] == 'e' || s[At] == 'E'))
                {
                    At++;
                    if (At < s.Length && (s[At] == '+' || s[At] == '-')) At++;
                    int digits = At;
                    while (At < s.Length && s[At] >= '0' && s[At] <= '9') At++;
                    if (At == digits) throw new JsonException("Bad number.");
                }
                double value;
                if (!double.TryParse(s.Substring(start, At - start), NumberStyles.Float, CultureInfo.InvariantCulture, out value) ||
                    double.IsInfinity(value))
                {
                    if (nativeHeader) return double.NaN;
                    throw new JsonException("Bad number.");
                }
                return value;
            }
        }

        // ------------------------------------------------------------------ writing

        public static string Write(object value)
        {
            var b = new StringBuilder();
            Write(b, value, 0);
            return b.ToString();
        }

        internal static string Canonical(object value)
        {
            var b = new StringBuilder();
            Write(b, value, 0, true);
            return b.ToString();
        }

        static void Write(StringBuilder b, object value, int depth, bool canonical = false)
        {
            if (depth > MaxDepth) throw new JsonException("JSON is nested too deeply.");
            if (value == null) { b.Append("null"); return; }
            var text = value as string;
            if (text != null) { Quote(b, text, canonical); return; }
            if (value is bool) { b.Append((bool)value ? "true" : "false"); return; }
            if (value is int || value is long || value is short || value is byte || value is uint)
            {
                b.Append(Convert.ToInt64(value, CultureInfo.InvariantCulture).ToString(CultureInfo.InvariantCulture));
                return;
            }
            if (value is double || value is float)
            {
                double d = Convert.ToDouble(value, CultureInfo.InvariantCulture);
                if (double.IsNaN(d) || double.IsInfinity(d)) { b.Append("null"); return; }
                b.Append(d.ToString("R", CultureInfo.InvariantCulture));
                return;
            }
            var map = value as IDictionary<string, object>;
            if (map != null)
            {
                b.Append('{');
                bool first = true;
                var keys = new List<string>(map.Keys);
                keys.Sort(StringComparer.Ordinal);
                foreach (var key in keys)
                {
                    if (!first) b.Append(',');
                    first = false;
                    Quote(b, key, canonical);
                    b.Append(':');
                    Write(b, map[key], depth + 1, canonical);
                }
                b.Append('}');
                return;
            }
            var list = value as IEnumerable;
            if (list != null)
            {
                b.Append('[');
                bool first = true;
                foreach (var item in list)
                {
                    if (!first) b.Append(',');
                    first = false;
                    Write(b, item, depth + 1, canonical);
                }
                b.Append(']');
                return;
            }
            throw new JsonException("Cannot write " + value.GetType().Name + " as JSON.");
        }

        public static void Quote(StringBuilder b, string s, bool canonical = false)
        {
            b.Append('"');
            foreach (char c in s)
            {
                switch (c)
                {
                    case '"': b.Append("\\\""); break;
                    case '\\': b.Append("\\\\"); break;
                    case '\n': b.Append("\\n"); break;
                    case '\r': b.Append("\\r"); break;
                    case '\t': b.Append("\\t"); break;
                    default:
                        // Control characters, line separators and lone surrogates' neighbours stay escaped.
                        if (canonical && c == '\b') b.Append("\\b");
                        else if (canonical && c == '\f') b.Append("\\f");
                        else if (c < 0x20 || (!canonical && (c == (char)0x2028 || c == (char)0x2029 || c == (char)0x7f)))
                            b.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                        else b.Append(c);
                        break;
                }
            }
            b.Append('"');
        }
    }
}
