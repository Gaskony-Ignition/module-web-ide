# The Designer's project-resource export

Measured off the real Designer on 8.3.8, not inferred from documentation and
not from the on-disk layout — the two differ in one field, which is the sort
of thing that makes a file the Designer refuses.

This module uses the **Designer-compatible resource zip** rather than plain
`.py` files: a file this module writes opens in the Designer, and a file the
Designer writes opens here, so the format is copied rather than approximated.

## Where it is in the Designer

| | |
| --- | --- |
| **Export** | Right-click **Project Library** in the Project Browser → `Export...` |
| **Import** | **File → Import…** (not the tree's context menu) |

The Project Library context menu is exactly four items: `New Script`,
`New Package`, `Paste` (Ctrl+V, greyed with an empty clipboard) and `Export...`.
There is no Import there — which is why this module puts an import entry in the
tree menu as well, so a first import has something to click.

## The export dialog

Titled **Export Project Resources**. A checkbox tree of EVERY resource type in
the project — Advanced Stylesheet, Gateway Event Scripts, Perspective Properties,
Project Script Library, and so on — with the branch you right-clicked
pre-selected and everything else unchecked. Links: `Select All`, `Local`, `None`.
Buttons: `Export` and `Send to Project`.

So "export the Project Library" is a SELECTION inside a whole-project export, not
a different operation. The file it writes is the same shape whatever is ticked.

Then an ordinary Save dialog:

- **Files of Type**: `Project Export (.zip)`
- **Default name**: `<Project>_<YYYY-MM-DD>_<HHMM>.zip`, e.g.
  `Mining_Demo_2026-09-07_0330.zip`

## What is in the zip

The project's own on-disk layout, subsetted to what was ticked, plus a manifest
at the root. Nothing is nested under a wrapper directory, and there is no index
of the contents — the paths ARE the index.

```
project.json
ignition/script-python/MiningDemo/config/resource.json
ignition/script-python/MiningDemo/config/code.py
ignition/script-python/MiningDemo/demo/resource.json
ignition/script-python/MiningDemo/demo/code.py
...
```

`project.json`, at the root:

```json
{
  "title": "ACME Mining Demo 1.7.0",
  "description": "Self-contained Ignition demonstration of ... · v1.7.0",
  "enabled": true,
  "inheritable": false,
  "parent": ""
}
```

Each resource is a directory holding `resource.json` and its data files, named by
the `files` array:

```json
{
  "scope": "A",
  "version": 1,
  "restricted": false,
  "overridable": true,
  "files": [
    "code.py"
  ],
  "attributes": {
    "hintScope": 2,
    "lastModificationSignature": "111e6d938040ef043abc55398751ffd66ec39ed29480255141d1bf5e91c09788",
    "lastModification": {
      "actor": "external",
      "timestamp": "2026-09-07T03:25:46Z"
    }
  }
}
```

**The one difference from the same resource on disk.** The exported
`resource.json` carries `lastModificationSignature`; the file in the
project's own data directory does not. Everything else — `scope`, `version`,
`restricted`, `overridable`, `files`, and `attributes.lastModification` — is
byte-identical to what the gateway holds. A `resource.json` without
`lastModification` is silently ignored on import, and `lastModification`
belongs inside `attributes`, not at the top level.

## The import dialog

**File → Import…** opens a file chooser filtered to `Project Export (.zip)`,
then a dialog titled **Import** which reads the zip and lists what it found as a
checkbox tree, grouped by resource type exactly as the export dialog groups them
— `Project Script Library` with each script under it. Links `Select All` /
`None`, and one `Import` button.

**Conflicts are handled AFTER the button, not before it.** The selection tree
looks identical whether or not the resources already exist. Press `Import` and,
for each one that does, a modal **Resolve Conflicts** appears:

> This project already has the following:
> *"Project Script Library - \_si\_designer\_check/roundtrip"*
>
> `Overwrite` · `Overwrite All` · `Skip` · `Skip All` · `Rename` · `Cancel`

The Designer does warn about overwriting and does offer a rename, contrary
to what watching only the selection dialog would suggest. The remaining
difference: this module reports `exists` per resource **in the selection
list**, so the choice is visible before committing rather than as a modal per
conflict afterwards. It has no `Rename`, which the Designer does.

The other thing it does not do: **no retarget.** Resources land at the paths in
the zip, in the project that is currently open. A zip exported from one project
imports into another by opening that other project first.

## Proved, not assumed

A zip written by this module (`/api/scripts/export`) round-trips through the
real Designer's File → Import: it lists the resource under **Project Script
Library** by name, raises **Resolve Conflicts** when the script already
exists, imports on `Overwrite`, and the script on the gateway afterwards is
byte-identical to the original.

Entry paths must come from `HandlerSupport.encodePath`, never
`ResourcePath.getPath()` — the latter drops the module and type, so entries
would read `MyPackage/helpers/code.py` instead of
`ignition/script-python/MyPackage/helpers/code.py`. In this format the paths
ARE the index — nothing else says what a resource is — so a zip built that
way imports as nothing, here and in the Designer alike, while looking
entirely reasonable in a listing.
