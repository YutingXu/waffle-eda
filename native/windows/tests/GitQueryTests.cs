// Incremental saves (docs/format-2.md): the scenarios of native/tests/project_journal.py
// ported to the Windows writer, cross-host replay of journals written by the Linux writer
// (native/linux/waffle.py, fixtures below), the bridge actions end to end, a JSON-lines worker so
// project_journal.py can drive this writer too, and gitQuery argument parity with git_head.py.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;

namespace Waffle.Windows.Tests
{
    static partial class Program
    {
        // gitQuery: Policy.GitQuery against git_head.py validate_query (the reference every host follows).
        // Expected: null = refused, "ok" = accepted, else the cleaned arguments. Generated with Python 3.
        static readonly Dictionary<string, string> GitQueryCases = new Dictionary<string, string> {
                { @"{""op"":""log"",""args"":{""search"":""<E*200>""}}", "ok" },
                { @"{""op"":""log"",""args"":{""search"":""<E*257>""}}", null },
                { @"{""op"":""log"",""args"":{""search"":""<a*256>""}}", "ok" },
                { @"{""op"":""log"",""args"":{""search"":""<a*257>""}}", null },
                { @"{""op"":""log"",""args"":{""search"":""<A*200>""}}", null },
                { @"{""op"":""log"",""args"":{""limit"":10000000}}", @"{""limit"":10000000}" },
                { @"{""op"":""log"",""args"":{""limit"":10000001}}", null },
                { @"{""op"":""log"",""args"":{""limit"":5.0}}", @"{""limit"":5}" },
                { @"{""op"":""log"",""args"":{""limit"":true}}", null },
                { @"{""op"":""log"",""args"":{""skip"":0,""limit"":1,""refs"":[""refs/heads/main"",""v1.0""],""search"":""Ana \u00e9""}}", @"{""limit"":1,""refs"":[""refs/heads/main"",""v1.0""],""search"":""Ana \u00e9"",""skip"":0}" },
                { @"{""op"":""installMergeDriver"",""args"":{""confirm"":1}}", null },
                { @"{""op"":""installMergeDriver"",""args"":{""confirm"":true}}", @"{""confirm"":true}" },
                { @"{""op"":""installMergeDriver"",""args"":{""confirm"":null}}", null },
                { @"{""op"":""log"",""args"":{""refs"":[]}}", @"{""refs"":[]}" },
                { @"{""op"":""log"",""args"":{""refs"":[""a\u007f""]}}", null },
                { @"{""op"":""log"",""args"":{""refs"":""main""}}", @"{""refs"":""main""}" },
                { @"{""op"":""log"",""args"":{""refs"":[1]}}", null },
                { @"{""op"":""lfsStatus"",""args"":{}}", @"{}" },
                { @"{""op"":""lfsLock"",""args"":{""confirm"":false}}", @"{""confirm"":false}" },
                { @"{""op"":""lfsUnlock"",""args"":{""confirm"":""yes""}}", null },
                { @"{""op"":""lfsLocks"",""args"":{""limit"":1}}", null },
                { @"{""op"":""commitPlan"",""args"":{}}", @"{}" },
                { @"{""op"":""commitPlan"",""args"":{""paths"":[""Board.wpcb""]}}", null },
                { @"{""op"":""commitStaged"",""args"":{""confirm"":true,""message"":""Layout"",""paths"":[""Sensor board/Board.wpcb""],""plan"":""<a*64>""}}", "ok" },
                { @"{""op"":""commitStaged"",""args"":{""paths"":""Board.wpcb""}}", null },
                { @"{""op"":""commitStaged"",""args"":{""paths"":[]}}", null },
                { @"{""op"":""log"",""args"":null}", @"{}" },
                { @"{""op"":""refs"",""args"":{""x"":1}}", null },
                { @"{""op"":""status"",""args"":{}}", @"{}" },
                { @"{""op"":""patches"",""args"":{""revisions"":[""AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA""]}}", null },
                { @"{""op"":""patches"",""args"":{""revisions"":[<R*256>],""head"":""x""}}", "ok" },
                { @"{""op"":""patches"",""args"":{""revisions"":[<R*257>]}}", null },
                { @"{""op"":""patches"",""args"":{""revisions"":[""eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee""]}}", @"{""revisions"":[""eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee""]}" },
                { @"{""op"":""patches"",""args"":{""revisions"":[""eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee""]}}", null },
                { @"{""op"":""log"",""args"":{""search"":null}}", null },
                { @"{""op"":""log"",""args"":{""search"":""\u0085\u2028""}}", @"{""search"":""\u0085\u2028""}" },
                { @"{""op"":""log"",""args"":{""search"":""tab\there""}}", null },
                { @"{""op"":""mergeBase"",""args"":{""a"":5,""b"":""main""}}", @"{""a"":5,""b"":""main""}" },
                { @"{""op"":""read"",""args"":{""revision"":""""}}", @"{""revision"":""""}" },
                { @"{""op"":""Refs"",""args"":{}}", null },
                { @"{""op"":""fileLog"",""args"":{""limit"":2,""skip"":3}}", @"{""limit"":2,""skip"":3}" },
                { @"{""op"":""projectLog"",""args"":{""limit"":500,""skip"":500,""snapshot"":""<a*64>""}}", "ok" },
                { @"{""op"":""sourceRevision"",""args"":{""revision"":""aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa""}}", "ok" },
                { @"{""op"":""sourceRevision"",""args"":{""path"":""another-file""}}", null },
                { @"{""op"":""sourceLog"",""args"":{""limit"":12,""skip"":1}}", "ok" },
                { @"{""op"":""projectBlobs"",""args"":{""revisions"":[<d*2>]}}", "ok" },
                { @"{""op"":""projectBlobs"",""args"":{""revisions"":[""HEAD""]}}", null },
                { @"{""op"":""folderRevisions"",""args"":{""stage"":""index"",""known"":[<d*2>]}}", "ok" },
                { @"{""op"":""folderRevisions"",""args"":{""known"":[""../elsewhere""]}}", null },
                { @"{""op"":""blameLog"",""args"":{""limit"":-0.0}}", @"{""limit"":0}" },
                { @"{""op"":""blameLog"",""args"":{""limit"":1.5}}", null },
                { @"{""op"":""blameLog"",""args"":{""limit"":1e7}}", @"{""limit"":10000000}" },
                { @"{""op"":""log"",""args"":{""search"":{""x"":1}}}", null },
                { @"{""op"":""log"",""args"":{""refs"":[[""x""]]}}", null },
                { @"{""op"":""log"",""args"":[]}", null },
        };

        static string Expand(string s) => Regex.Replace(s, "<(\\w)\\*(\\d+)>", m =>
        {
            int n = int.Parse(m.Groups[2].Value);
            switch (m.Groups[1].Value)
            {
                case "E": return string.Concat(Enumerable.Repeat("\\ud83d\\ude00", n));
                case "a": return new string('a', n);
                case "A": return string.Concat(Enumerable.Repeat("e\\u0301", n));
                default: return string.Join(",", Enumerable.Repeat("\"" + new string('d', 40) + "\"", n));
            }
        });

        static void GitQueryParityTests()
        {
            group = "git query parity";
            foreach (var pair in GitQueryCases)
            {
                var q = (Dictionary<string, object>)Json.Parse(Expand(pair.Key));
                var got = GitQuery.Arguments((string)q["op"], q["args"]);
                bool ok = pair.Value == null ? got == null
                    : pair.Value == "ok" ? got != null
                    : got == Json.Write(Json.Parse(pair.Value));
                Check(ok, pair.Key.Length > 90 ? pair.Key.Substring(0, 90) : pair.Key);
            }
            var pageQueries = new[] { "createBranch", "refs", "status", "log", "fileLog", "projectLog", "projectBlobs", "folderRevisions", "sourceRevision", "sourceLog", "read", "mergeBase", "blameLog", "patches", "installMergeDriver", "mergeDriverPlan" };
            var lfsQueries = new[] { "lfsStatus", "lfsLocks", "lfsLock", "lfsUnlock" };
            var commitQueries = new[] { "commitPlan", "commitStaged" };
            Check(new HashSet<string>(pageQueries.Concat(lfsQueries).Concat(commitQueries)).SetEquals(GitQuery.Ops.Keys), "all native Git queries have Windows parity");
        }
    }

}
