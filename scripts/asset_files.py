"""Write deterministic application assets without replacing unchanged files."""
import os
from contextlib import contextmanager
from pathlib import Path
import tempfile
from fnmatch import fnmatchcase

APP_TOOLKIT_SOURCES = {
    'ui/analysis-panels.css',
    'ui/commit-graph.js',
    'ui/components.css',
    'ui/controls.css',
    'ui/dialog.js',
    'ui/gallery.css',
    'ui/gallery.js',
    'ui/history-panels.css',
    'ui/kit.js',
    'ui/motion.js',
    'ui/overlay-scroll.js',
    'ui/rule-set-lists.css',
    'ui/select-popup.js',
    'ui/shortcut.css',
    'ui/shortcut.js',
    'ui/spatial-motion.css',
    'ui/spatial-motion.js',
    'ui/spreadsheet.css',
    'ui/surface-motion.js',
    'ui/tooltip.css',
    'ui/tooltip.js',
    'ui/whole-pixels.js',
}
_APP_RENAMED_SOURCES = {
    'automation/command-catalog.js': 'butter-catalog.js',
    'automation/ai-ui.js': 'butter-ai-ui.js',
    'automation/ai-service.js': 'butter-ai.js',
    'notebook/datasheet-commands.js': 'butter-datasheets.js',
    'automation/design-drop-service.js': 'butter-drop.js',
    'automation/editor-command-host.js': 'butter-editor.js',
    'editor/workspace-tools.css': 'butter-intel-ui.css',
    'editor/workspace-tools.js': 'butter-intel-ui.js',
    'project/links-ui.js': 'butter-links-ui.js',
    'project/link-commands.js': 'butter-links.js',
    'automation/macros-ui.js': 'butter-macros-ui.js',
    'automation/macro-service.js': 'butter-macros.js',
    'editor/motion-service.js': 'butter-motion.js',
    'editor/numeric-field-commands.js': 'butter-numericFields.js',
    'formats/odb-commands.js': 'butter-odb.js',
    'checks/query-service.js': 'butter-query-service.js',
    'checks/query-ui.js': 'butter-query-ui.js',
    'checks/query-commands.js': 'butter-query.js',
    'project/saved-view-commands.js': 'butter-savedViews.js',
    'notebook/slide-commands.js': 'butter-slides.js',
    'notebook/table-commands.js': 'butter-tables.js',
    'history/visual-history-commands.js': 'butter-visualHistory.js',
    'native-bridge/window-commands-ui.js': 'butter-windows-ui.js',
    'native-bridge/window-commands.js': 'butter-windows.js',
    'automation/command-broker.js': 'butter.js',
    'editor/editor-motion.js': 'motion.js',
}


def app_source_name(app, path):
    relative = Path(path).relative_to(app).as_posix()
    return _APP_RENAMED_SOURCES.get(relative, Path(path).name)


def app_source_files(app, pattern, *, include_toolkit=False):
    """Return first-party app sources in their established source order."""
    app = Path(app)
    files = []
    for path in app.rglob("*." + pattern.rsplit(".", 1)[-1]):
        relative = path.relative_to(app)
        parts = relative.parts
        if not path.is_file() or parts[0] in ("vendor", "locales", "fab-presets"):
            continue
        if parts[0] == "extensions" and (len(parts) < 3 or parts[1] != "host"):
            continue
        if not include_toolkit and relative.as_posix() in APP_TOOLKIT_SOURCES:
            continue
        if fnmatchcase(app_source_name(app, path), pattern):
            files.append(path)
    return sorted(files, key=lambda file: (app_source_name(app, file), file.as_posix()))


@contextmanager
def staged_output(destination):
    """Yield a temporary path and replace destination after the writer returns."""
    destination = Path(destination)
    with tempfile.NamedTemporaryFile(dir=destination.parent, prefix="." + destination.name + ".", delete=False) as out:
        tmp = Path(out.name)
        try:
            out.close()
            yield tmp
            os.chmod(tmp, 0o644)
            os.replace(tmp, destination)
        finally:
            tmp.unlink(missing_ok=True)


def write_asset(path, content):
    path = Path(path)
    data = content.encode("utf-8") if isinstance(content, str) else content
    try:
        if path.read_bytes() == data:
            return False
    except FileNotFoundError:
        pass
    path.parent.mkdir(parents=True, exist_ok=True)
    with staged_output(path) as tmp:
        tmp.write_bytes(data)
    return True
