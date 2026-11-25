# Waffle EDA for Visual Studio Code

Open a Waffle project folder in VS Code and select its `.waffle` manifest. **Waffle: Open Preview** displays the project's boards and sheets. The viewer reads the declared native members beside the manifest and uses Waffle's renderer for pan, zoom and fit. Keep the folder together when copying a design.

- **Preview and validation** work in untrusted workspaces. The extension validates native manifest, schematic, PCB, drawing, panel, library and layout block records as newline-delimited JSON. The optional `waffle.validation.schema` setting also checks each row against the bundled record schema. VS Code’s JSON editor remains available for standalone proposals and engineering change orders.
- **Run Design Rule Check** and **Run Electrical Rule Check** check the saved folder with the Waffle CLI and place findings on the source records in Problems. **Generate Outputs** offers fabrication files, BOMs, PDFs and saved output jobs. These commands require Python 3 and an installed Waffle MCP server. Set `waffle.serverPath` or `waffle.pythonPath` if needed.
- **Summarise Changes Since Git HEAD** compares the native manifest and members from the committed tree with the current worktree, including open modified member texts. The standalone `bin/waffle-summary.js BEFORE_PROJECT AFTER_PROJECT` accepts two saved project directories or their manifests.

Checks, outputs and Git access require a trusted workspace. The viewer runs locally with a restrictive Content Security Policy. The extension writes outputs only on request. Make design changes and save coherent project revisions in Waffle.

Files from pre-release Waffle builds require re-import from their original EDA source.

## Run or install

VS Code 1.80 or later is supported. Build from the Waffle repository with `python3 integrations/vscode/scripts/package-vsix.py`. Install the resulting VSIX using **Extensions: Install from VSIX…**.

For an Extension Development Host, run `python3 integrations/vscode/scripts/bundle-viewer.py`, then `code --extensionDevelopmentPath="$PWD/integrations/vscode" .`. Run the extension's focused tests with `node tests/extensions/vscode-extension.cjs`.
