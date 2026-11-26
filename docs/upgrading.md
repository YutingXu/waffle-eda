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

On macOS, choose **Help › Check for Updates…**. Waffle contacts GitHub only when you ask it
to check or download an update. It sends no account, installation, project or version identifiers.
The updater verifies the Ed25519-signed manifest and offers only a newer release with its notes and
download size.

- **Install Update** downloads and verifies the macOS archive. Before restarting, Waffle asks to save
  any changes across open documents and gives you a chance to cancel. If the new editor fails to
  start, Waffle restores and reopens the previous version.
- **Download** saves a verified archive for manual installation when your copy of Waffle is outside
  Applications or lacks write permission. Quit Waffle, unzip the archive and move the new app into
  Applications.
- **What’s New** shows the previous version the first time a new version starts.

For Linux and Windows, install the appropriate package manually. [Waffle downloads](https://github.com/YutingXu/waffle-eda/releases)

## Rolling back

To go back to an earlier Waffle:

1. Quit Waffle.
2. Install the earlier build from a trusted copy. Replace Waffle.app, install the earlier Debian package with your package manager, or extract the earlier Windows ZIP.
3. Check that the installed version supports your project format before opening the project. Apricot Preview is the first supported release for native 2.0. Keep the original source EDA project and a copy of the complete saved folder.
4. Export your settings from Preferences › General › Settings sync before updating if you may roll back. An older
   Waffle refuses a settings file from a newer one rather than applying part of it.

Your preferences, key map and theme stay where they are when you roll back; values the older
version doesn't know are ignored, not deleted.
