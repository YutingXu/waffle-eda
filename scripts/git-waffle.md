# Reviewing Waffle designs with Git

A saved Waffle project is a directory. Its manifest and native text members store one canonical JSON record per line. Git can show the exact change to a board, sheet, library or project reference directly.

```sh
git diff HEAD -- '*.waffle' '*.wsch' '*.wpcb' '*.wlib' '*.wblock' '*.wdraw' '*.wpanel'
```

For a project-wide semantic comparison, select **Project → Compare revisions** in Waffle, or run `bin/waffle-diff --project path/to/Project.waffle --before HEAD`. The command reads the manifest and its members from the selected working tree and revision.

## Optional text conversion

The textconv driver passes native record bytes through and renders standalone `.waffle-eco` change orders by field. Unrecognized text, including conflict markers, stays visible. Add `*.waffle-eco diff=waffle` to the design repository's `.gitattributes`. From the repository, configure the absolute path to the script in the Waffle checkout.

```sh
git config --local diff.waffle.textconv 'python3 /path/to/Waffle/scripts/git-waffle-diff.py'
git diff HEAD -- '*.waffle-eco'
```

Use `git diff --no-textconv` for a patch intended for `git apply`.

## Merging designs

Plain Git can merge edits to different files or well-separated records. The optional Waffle driver matches records by ID, so edits to adjacent records can merge too. It combines independent fields on the same record, such as a part move and a value change. It asks for review when branches edit the same field or coupled geometry differently, add different records with the same ID, or remove and edit the same record.

Register the merge driver once per clone. Either choose **Project › Git › Set Up Merge Driver…** in the desktop app, or run:

```sh
python3 native/git_head.py --install-merge-driver /path/to/design-repo
```

Setup registers `merge.waffle.name` and `merge.waffle.driver` in that repository's local Git config and adds entries to `.gitattributes` for `.waffle`, `.wsch`, `.wpcb`, `.wdraw`, `.wpanel`, `.wlib` and `.wblock`. Commit `.gitattributes` to share the entries. Each clone registers the driver explicitly. `--uninstall-merge-driver <repo>` removes the local config section.

When a conflict remains, Git keeps Base, Ours and Theirs in the index. The optional driver keeps the Ours file intact. In Waffle, choose **Project › Git › Resolve Merge Conflicts…** to compare sides and choose a resolution. **Apply to Editor** updates the design, **File › Save** writes it, and you stage the result in Git. When the conflict involves records the editor cannot resolve safely, review the exact file versions in Git or export them from the dialog.

## History, blame and branches

All of these read Git through the desktop host, read-only.

- **Project › Git › Project History** opens a document tab from either editor. The graph follows local branches, remote-tracking branches and tags. Each commit shows what changed against its first parent, electrical, mechanical and cosmetic counts, and paired thumbnails. Use the counter below a thumbnail to browse changed sheets or distant PCB regions. Open a commit to Compare, or tick two commits in before-to-after order and choose **Compare selected**. The tab reads the saved project's repository automatically. Its summary cache lives in the desktop web view's IndexedDB and uses both project blob IDs.
- **Project › Git › File History…** (also the History panel's Git tab) lists every commit that changed the project. Each commit offers Compare with Previous, Compare with Working, and Restore as Copy.
- The Properties panel shows who last changed the selected object. Right-click › **Show History of This Object** lists every change, field by field. On a net, use **Show History of Net …**.
- **Compare Branches…** compares any two revisions with a commit graph. It can also show only what a branch changed since it branched off (the merge base, like `git diff A...B`).
- **What Changed Since Last Opened** compares the working design with the commit you had when you last opened the project.
