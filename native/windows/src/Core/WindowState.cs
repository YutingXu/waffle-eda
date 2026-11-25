// Window size and position, remembered between launches (macOS: setFrameAutosaveName).
// Pure rules so the tests can check them: a remembered frame is reused only while enough of
// its title bar is on a screen that still exists; otherwise the window is centred.
using System;
using System.Collections.Generic;
using System.Globalization;

namespace Waffle.Windows
{
    public struct Rect
    {
        public int X, Y, Width, Height;
        public Rect(int x, int y, int w, int h) { X = x; Y = y; Width = w; Height = h; }
        public int Right => X + Width;
        public int Bottom => Y + Height;
        public override string ToString() => X + "," + Y + "," + Width + "," + Height;
    }

    public sealed class WindowFrame
    {
        public Rect Bounds;
        public bool Maximized;

        public string Serialize() => Json.Write(new Dictionary<string, object> {
            { "x", Bounds.X }, { "y", Bounds.Y }, { "width", Bounds.Width }, { "height", Bounds.Height }, { "maximized", Maximized } });

        public static WindowFrame Parse(string text)
        {
            try
            {
                var d = Json.Parse(text) as Dictionary<string, object>;
                if (d == null) return null;
                Func<string, int?> n = k =>
                {
                    object v;
                    if (!d.TryGetValue(k, out v) || !(v is double)) return null;
                    double x = (double)v;
                    if (x < -100000 || x > 100000) return null;
                    return (int)Math.Round(x);
                };
                int? x0 = n("x"), y0 = n("y"), w = n("width"), h = n("height");
                if (x0 == null || y0 == null || w == null || h == null) return null;
                object m;
                return new WindowFrame { Bounds = new Rect(x0.Value, y0.Value, w.Value, h.Value),
                                         Maximized = d.TryGetValue("maximized", out m) && m is bool && (bool)m };
            }
            catch (JsonException) { return null; }
        }

        /// The default frame: 1380 x 870 logical pixels, at most 94% x 91% of the work area, centred.
        public static Rect Default(Rect work, double scale)
        {
            int w = Math.Min((int)Math.Round(1380 * scale), (int)(work.Width * 0.94));
            int h = Math.Min((int)Math.Round(870 * scale), (int)(work.Height * 0.91));
            return new Rect(work.X + (work.Width - w) / 2, work.Y + (work.Height - h) / 2, w, h);
        }

        /// The frame to show: the remembered one if a strip of its title bar (at least 120 x 32 px)
        /// lies on one of the screens, clamped to the minimum size; else the default on the primary.
        public static Rect Restore(WindowFrame saved, IList<Rect> workAreas, Rect primary, double scale, int minWidth, int minHeight)
        {
            if (saved != null)
            {
                var b = saved.Bounds;
                int w = Math.Max(b.Width, minWidth), h = Math.Max(b.Height, minHeight);
                var title = new Rect(b.X, b.Y, w, (int)Math.Round(32 * scale));
                foreach (var area in workAreas)
                {
                    int left = Math.Max(title.X, area.X), right = Math.Min(title.Right, area.Right);
                    int top = Math.Max(title.Y, area.Y), bottom = Math.Min(title.Bottom, area.Bottom);
                    if (right - left >= 120 && bottom - top >= Math.Min(title.Height, 16))
                        return new Rect(b.X, b.Y, Math.Min(w, Math.Max(minWidth, area.Width * 2)), Math.Min(h, Math.Max(minHeight, area.Height * 2)));
                }
            }
            return Default(primary, scale);
        }
    }
}
