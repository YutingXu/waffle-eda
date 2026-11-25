"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");

const libraryFixture = path.join(__dirname, "../fixtures/format-2/workshop/libraries/Sense pad.wlib");

function cases(page, profile = "light") {
  const dialog = name => page.getByRole("dialog", {name,exact:typeof name === "string"});
  const button = (scope,name) => scope.getByRole("button", {name,exact:true});
  const action = id => page.evaluate(async id => {
    const host = AtriumNavHost, dependencies = AtriumLazy.forAction(id,host.doc()?.kind);
    if (dependencies) await AtriumLazy.need(dependencies);
    void host.act(id);
  }, id);
  const restore = () => page.evaluate(async () => {
    window.geometryReviewProject ??= structuredClone(AtriumNavHost.project());
    return AtriumNavHost.replaceProject(structuredClone(geometryReviewProject), {force:true,dirty:false});
  });
  const sheet = kind => page.evaluate(async kind => {
    const host = AtriumNavHost, ref = host.documentRefs().find(row => row.kind === kind);
    if (!ref) throw Error("The demo has no " + kind + " document.");
    await host.selectDocument(ref.id);
  },kind);
  const realtime = enabled => page.evaluate(async enabled => {
    await AtriumLazy.need(["AtriumPrefs","AtriumCollabPresence"]);
    AtriumPrefs.set("collab.realtime",enabled);
  },enabled);
  const localJoin = () => page.evaluate(async () => {
    const host = AtriumNavHost;
    const [T,C] = await AtriumLazy.need(["AtriumCollabTransport","AtriumCollabCRDT"]);
    const remote = "p" + "H".repeat(22), me = "p" + "G".repeat(22);
    const roomKey = "ABCD-EFGH-JKMN-PQRS-TUVW-XYZ2-3456";
    const model = structuredClone(host.project()), replica = C.create({replica:remote,project:model});
    let wire;
    // This drives the shipping join, snapshot and restore protocol in the real editor.
    // The loopback transport never opens a socket or sends a message to another process.
    window.AtriumCollabTransport = {...T,async connect(options) {
      wire = options;
      return {peer:me,room:"review-fixture",state:"open",rtc:true,
        async send(){},paths:() => new Map(),close(){}};
    }};
    if (!await AtriumCollabLive.join("ws://127.0.0.1:1",roomKey,{host:remote,salt:T.newSalt()}))
      throw Error("The local collaboration fixture failed to join.");
    const receive = (kind,body) => wire.onMessage(kind,body,remote,{host:true});
    wire.onState("open",{peers:2});
    receive("hello",{name:"Local review host",has:true,vv:replica.vv(),personalUndo:2,sharedRestore:"host",joinRound:1});
    receive("snapshot",{to:me,joinRound:AtriumCollabLive.session().joinRound,snap:structuredClone(replica.snapshot())});
    window.geometryRestoreCheck = phase => {
      host.canvas().focus();
      receive("restore",{to:me,id:"local-restore",phase});
    };
    window.geometryLeaveReview = () => {
      AtriumCollabLive.leave();
      window.AtriumCollabTransport = T;
    };
  });
  const fixtures = [
    {name:"Collaboration status and editable display name",async open() {
      await restore();
      await action("collab-status");
      await dialog("Collaboration").getByRole("textbox",{name:/Your display name/}).waitFor();
    }},
    {name:"Enable live sessions",async open() {
      await realtime(false);
      await action("collab-live");
      await button(dialog("Live Session"),"Turn On Live Sessions").waitFor();
    }},
    {name:"Live session address and code fields",async open() {
      await realtime(true);
      await action("collab-live");
      const target = dialog("Live Session");
      await target.getByRole("textbox",{name:/^Invitation/}).fill("127.0.0.1:48765");
      await target.getByRole("textbox",{name:/^Session code/}).waitFor();
    }},
    {name:"Explain macOS local network permission before starting",macOnly:true,async open() {
      await realtime(true);
      await page.evaluate(() => {
        AtriumPrefs.set("collab.lanExplained",false);
        window.AtriumHost = {lanAvailable:true,lanStart() {throw Error("The geometry fixture cannot start a listener.");}};
      });
      await action("collab-live");
      const live = dialog("Live Session");
      await live.getByRole("checkbox",{name:"Visible on this network",exact:true}).check();
      await button(live,"Start Session").click();
      await button(dialog("Local network access"),"Continue").waitFor();
      await page.evaluate(() => { delete window.AtriumHost; });
    }},
    {name:"Save unsaved edits before joining a live session",async open() {
      await restore();
      const invite = await page.evaluate(async () => {
        const T = await AtriumLazy.need("AtriumCollabTransport");
        const host = AtriumNavHost;
        host.edit(() => { host.project().name += " edited"; },"Edit project name");
        return T.invitation({relay:"ws://127.0.0.1:1",roomKey:T.newRoomKey(),host:"p"+"H".repeat(22),salt:T.newSalt()}).link;
      });
      await action("collab-live");
      const live = dialog("Live Session");
      await live.getByRole("textbox",{name:/^Invitation/}).fill(invite);
      await button(live,"Join Session").click();
      await button(dialog(/^Save changes to “.+” before joining\?$/),"Save and Join").waitFor();
    }},
    {name:"Live session roster with a local verified peer",async open() {
      await restore();
      await localJoin();
      await page.waitForFunction(() => !!AtriumCollabLive.session()?.r);
      await page.locator("#collab-faces").getByRole("button",{name:"Local review host",exact:true}).click();
      await dialog("People here").getByText("Local review host",{exact:true}).waitFor();
    }},
    {name:"Guest holds edits while the host restores a shared version",async open() {
      await page.evaluate(() => geometryRestoreCheck("check"));
      await dialog("Restoring shared version").getByText("The host is restoring a shared version…",{exact:true}).waitFor();
    }},
    {name:"Add a review comment on a selected component",async open() {
      await page.evaluate(() => {
        window.geometryLeaveReview?.();
        for (const d of document.querySelectorAll("dialog[open].collab-dialog")) d.close();
      });
      await restore();
      await sheet("schematic");
      await page.evaluate(() => {
        const host = AtriumNavHost, item = host.doc().items.find(row => row.kind === "part");
        if (!item) throw Error("The demo schematic has no component.");
        host.select([item.id],item.id);
      });
      await action("comment-add");
      const target = dialog("Add Comment");
      await target.getByRole("combobox",{name:"Attach to"}).waitFor();
      await target.getByRole("textbox",{name:"Comment",exact:true}).waitFor();
    }},
    {name:"Review Changes when the visual comparison module is unavailable",async open() {
      // This fixture opens file://, where Chromium can bypass Playwright request routing.
      const restoreLoader = await page.evaluateHandle(() => {
        const head = document.head, append = head.append;
        head.append = function (...nodes) {
          for (const node of nodes) {
            if (node instanceof HTMLScriptElement && node.src.endsWith("/history/diff-view.js")) {
              node.src = new URL("missing-diff-view.js", node.src).href;
            }
          }
          append.apply(this, nodes);
        };
        return () => { head.append = append; };
      });
      try {
        await action("review-changes");
        const target = dialog("Could not open comparison");
        await button(target, "Cancel").waitFor();
        await button(target, "Retry").waitFor();
      } finally {
        await restoreLoader.evaluate(restore => restore());
        await restoreLoader.dispose();
      }
    }},
    {name:"Open Board Revisions and start the first draft",async open() {
      await sheet("pcb");
      await action("revisions");
      const target = dialog("Board Revisions");
      await target.getByRole("textbox",{name:"First revision"}).waitFor();
      await button(target,"Start Rev A").waitFor();
    }},
    {name:"Project actions open the Cross-sheet connections setting",async open() {
      const trigger = page.getByRole("button",{name:/^Project actions for /});
      await trigger.press("Enter");
      const menu = page.getByRole("menu",{name:/^Project actions for /});
      await menu.getByRole("menuitem",{name:/^Connections: /}).press("Enter");
      const target = dialog("Cross-sheet connections");
      await target.getByRole("combobox",{name:"Net identifier scope"}).waitFor();
      await button(target,"Apply").waitFor();
    }},
    {name:"Close Project with an unsaved design edit",async open() {
      await page.evaluate(() => AtriumNavHost.edit(() => { AtriumNavHost.project().name += " edited"; },"Edit project name"));
      await action("close-project");
      const target = dialog(/^Save changes to “.+” before closing\?$/);
      await button(target,"Don’t Save").waitFor();
    }},
    {name:"Explain a rule violation found in a real PCB check",async open() {
      await restore();
      await sheet("pcb");
      await page.evaluate(() => {
        const host = AtriumNavHost, doc = host.doc();
        host.edit(() => doc.items.push(
          {id:"review-short-a",kind:"track",layer:"Top",net:"TEST_A",width:.5,points:[[8,8],[12,8]]},
          {id:"review-short-b",kind:"track",layer:"Top",net:"TEST_B",width:.5,points:[[10,6],[10,9]]}
        ),"Place tracks on two nets",null,{documents:[doc.id]});
      });
      await action("drc");
      await page.waitForFunction(() => AtriumDRCView.violations(AtriumNavHost.currentId())?.length > 0);
      await action("drc-explain");
      await page.locator("dialog[open]").filter({has:page.getByRole("button",{name:"Rules…",exact:true})}).waitFor();
    }},
    {name:"Open a standalone Waffle library through normal file intake",async open() {
      await restore();
      const bytes = await fs.readFile(libraryFixture);
      await page.evaluate(data => {
        const bytes = Uint8Array.from(atob(data),char => char.charCodeAt(0));
        window.geometryReviewOpen = AtriumNavHost.openFiles([new File([bytes],"Sense pad.wlib")]);
      },bytes.toString("base64"));
      const target = dialog("Sense pad");
      await button(target,"Edit Footprint…").waitFor();
      await button(target,"Save").waitFor();
    }},
  ];
  // The light profile represents macOS. The Windows profiles have no app-side
  // Local Network explanation, since they do not request the macOS permission.
  return fixtures.filter(test => !test.macOnly || profile === "light");
}

module.exports = {cases};
