# Links to Waffle

A Waffle link names one object in one project, such as a component, a track, a sheet, a saved query or a datasheet page. Paste it into a note, a Git commit message, an issue or a chat. Opening it brings Waffle to that object.

```text
waffle://<project id>/<object id>
waffle://<project id>/<datasheet id>#datasheet:page=12
```

Both IDs are the record identities Waffle saves with the project. A link carries no file name, path or command, so it can only point at a project you already have.

## Copy a link

Save the project once so its objects have identities. Then select one object and choose **Copy link** under **Properties → Links**, or run **Copy Link** from the command palette. With nothing selected, Copy Link copies a link to the current document.

## Open a link

- **Inside Waffle.** Paste the link into the command palette and choose **Open link**, or run **Open Waffle Link…**. In a notebook note, Ctrl-click (⌘-click on macOS) or tap a link.
- **From another app.** Click the link in a browser, a chat or a document. Your browser may ask whether to open Waffle first.

Waffle selects and frames the object. When its project is not open, Waffle looks for it in **Recent projects**. If exactly one recent project has that identity, Waffle opens it and asks first if the current project has unsaved changes. Otherwise Waffle asks you to choose the project folder, and refuses a folder whose project identity does not match the link. A link never opens a project by itself from a path.

A message explains a link that cannot be opened: the object was deleted, the project was not found, two recent projects share the identity, or part of the project is still loading.

A datasheet page link opens the PDF reader at that page when **Datasheets** is on. Without it, the link still resolves in **Properties → Links**, but no reader opens.

## Links in Properties

**Properties → Links** shows the links stored on the selected object, the places that refer to it, and what would break if you deleted it.

- **Add link from this object…** stores a link to another object, document or net. One Undo removes it.
- A broken link shows the reason. **Inspect…** offers **Choose replacement…** or **Remove link**.
- **Referenced by** groups the notes, links and Git commits that name the object. In the desktop apps, tick **Include Git commits** to search the project's history for commit messages that contain its link.
- With nothing selected, the section lists every stored link in the project with its health.

## Desktop registration

- **macOS.** The app registers `waffle://`.
- **Debian or Ubuntu.** The package registers `waffle://` for the desktop.
- **Windows.** The optional MSIX build registers `waffle://`. With the portable ZIP, run `Register-WaffleDocumentTypes.ps1` from the extracted folder once. It registers `waffle://` for your Windows account along with the document types. Run it with `-Unregister` before you delete that copy. Without the script, links still open inside Waffle but not from other apps. See [Windows](windows.md).
- **Browser edition.** Links open only within the project that is already open.

## MCP and command line

The `butter.links.*` commands, such as resolve, backlinks, list, create, rebind and remove, are available through `run_command` in every MCP workspace. Edits still need `--allow-write`. `--enable-butter links` is accepted but no longer needed. See [MCP and command line](mcp-and-cli.md).

## Turning links off

Links are on in every profile. A settings file that sets `butter.links` to `false` turns them off for that profile. **Preferences → General → Reset all settings…** turns them back on.
