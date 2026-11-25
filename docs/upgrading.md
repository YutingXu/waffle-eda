# Upgrading Waffle EDA

Waffle EDA 0.7.0 Apricot Preview opens native 2.0 project folders. To bring forward a design from Waffle 1.x, re-import its original EDA project, such as the Altium or KiCad source.

## What happens to your projects

Installing the editor leaves your projects in place. Select the project folder or its `.waffle` manifest to open it. An ordinary Save writes the active document and any new assets it references. Save All includes the other dirty documents.

Keep or copy the whole project folder, including its manifest, sheets, boards, libraries, models, assets and hidden `.waffle` directory when present. Save as Zip creates a portable copy of the saved design. Help › Check for Updates… lists the native file format for the installed version. [Native project format](format-2.md)

## Settings, key maps, layouts and themes

Everything you export or that Waffle keeps for you carries a version, and newer Waffle versions
read every older one:

| Data | Where | Version |
|---|---|---|
| Preferences | `waffle-preferences.json` from older versions (`atrium-prefs`) | 1 |
| All settings | Preferences › General › Settings sync › Export all settings… (`atrium-settings`: preferences, appearance, key map, panel layout) | 1 |
| Key map | Keyboard shortcuts › Export… (`.waffle-keys`) | 1 (files without a version are read as 1) |
| Theme | the theme gallery's Export theme (`atrium-theme`) | 1 (files without the format key are read as 1) |
| Workspace layouts | stored as preferences (`workbench.layout`, `workbench.layouts`) | 1 |
| Clipboard history | this computer only (`atrium.clipboard.v1`) | 1 |
| Recovery snapshots | this computer only | 2 (version 1 workspaces are migrated) |

A settings file from a *newer* Waffle is refused with "These settings come from a newer Waffle";
nothing is applied, so your current settings stay as they are.

## Extensions

Extensions declare their API major in `waffle-extension.json` using `apiVersion`. Waffle provides version 1. The registry index carries the numeric API major. A package's own `version` identifies its release. Waffle names an unsupported API version before activating the package.

Within API v1, existing method names, command and widget IDs, argument meanings and result fields keep their meanings. New optional fields and contributions are additive. An incompatible change requires a new API major and upgrade notes. Stored widget records refer to their extension and widget by ID, so keep both IDs stable when updating a package. [API reference](extension-api.md) · [Sheet widget contract](extension-api.md#sheet-widgets)

A widget's installed declaration controls which saved properties its callbacks receive. When adding a primitive property, give it a default so existing widgets can render. New list properties appear empty. An older package can update its declared values while the host retains unfamiliar saved properties, including values on surviving list row IDs. Changing a property's type or tightening its bounds requires checking the saved values and planning any migration.

Extensions, console scripts and MCP scripts share the v1 scripting API. Access is checked by the calling host. A widget interaction can update its declared state in one Undo step. An AI provider can propose a design edit through the approved tool path. Explicit write authority is required to apply it. [Scripting](scripting.md)

## Checking for updates

Help › Check for Updates… shows your version, its project format and extension API, and the
compatibility notes above.

- **Off by default.** Waffle makes no network request for updates until you tick
  "Check for updates once a day". Then it contacts github.com at most once a day, and
  **Check Now** checks immediately.
- **Signed.** Waffle reads the release manifest from the project's GitHub Releases and verifies
  its signature with a public key built into the app. A manifest that is unsigned, or whose
  signature doesn't match, is ignored. A build with no signing key (development builds) cannot
  check for updates and says so.
- **Never installs by itself.** When an update is available, Waffle shows its notes and a
  download button. The download starts only when you click; Waffle checks its size and SHA-256
  against the signed manifest and discards it if they differ; then it asks where to save it.
  You install it yourself:
  - macOS: open the download and move Waffle.app to Applications, replacing the old one.
  - Linux: install the downloaded `waffle-eda_<version>_all.deb` with `sudo apt install ./<downloaded-file>.deb`.
  - Windows: unzip it and replace the old Waffle folder.
- **What's New.** The first time a new version starts, it shows Help › What's New with a line
  saying which version you updated from.

## Rolling back

To go back to an earlier Waffle:

1. Quit Waffle.
2. Install the earlier build from a trusted copy. Replace Waffle.app, install the earlier Debian package with your package manager, or extract the earlier Windows ZIP.
3. Check that the installed version supports your project format before opening the project. Apricot Preview is the first supported release for native 2.0. Keep the original source EDA project and a copy of the complete saved folder.
4. Export your settings from Preferences › General › Settings sync before updating if you may roll back. An older
   Waffle refuses a settings file from a newer one rather than applying part of it.

Your preferences, key map and theme stay where they are when you roll back; values the older
version doesn't know are ignored, not deleted.
