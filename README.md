# GNOME Notes Panel

A GNOME Shell extension that provides quick access to GNOME Notes directly from the top panel.

The extension reads the note index maintained by GNOME Notes and displays local as well as synchronized Nextcloud notes in a compact panel menu.

## Features

* Access GNOME Notes from the top panel
* Display local and Nextcloud notes
* Sort notes by last modification date
* Open individual notes directly in GNOME Notes
* Refresh the displayed note list
* Rebuild the GNOME Notes index when deleted notes remain visible
* German translation included
* Non-blocking asynchronous database queries

## Screenshots

![Screenshot of the Menu](docs/screenshot-menu.png?raw=true "Menu")
![Screenshot of the panel and the opened gnome notes app](docs/screenshot-panel.png?raw=true "Panel")

## Requirements

* GNOME Shell 48, 49 or 50
* GNOME Notes / Bijiben
* TinySPARQL
* Bash
* GNU core utilities
* `pkill`
* `gtk-launch`

On Debian-based distributions, TinySPARQL can usually be installed with:

```bash
sudo apt install tinysparql
```

On Arch Linux and CachyOS, the required Tracker/TinySPARQL components are normally installed as dependencies of GNOME.

Check whether TinySPARQL is available:

```bash
command -v tinysparql
```

## Installation

Clone the repository into the local GNOME Shell extensions directory:

```bash
git clone \
    https://github.com/USERNAME/gnome-notes-panel.git \
    ~/.local/share/gnome-shell/extensions/gnome-notes-panel@nordcomputer
```

Make the index rebuild script executable:

```bash
chmod +x \
    ~/.local/share/gnome-shell/extensions/gnome-notes-panel@nordcomputer/rebuild-index.sh
```

Compile the German translation:

```bash
cd ~/.local/share/gnome-shell/extensions/gnome-notes-panel@nordcomputer

mkdir -p locale/de/LC_MESSAGES

msgfmt \
    po/de.po \
    --output-file=locale/de/LC_MESSAGES/gnome-notes-panel@nordcomputer.mo
```

Enable the extension:

```bash
gnome-extensions enable gnome-notes-panel@nordcomputer
```

Depending on the GNOME session, logging out and back in may be required before the extension appears.

Check the extension status:

```bash
gnome-extensions info gnome-notes-panel@nordcomputer
```

## Usage

Click the GNOME Notes icon in the top panel to open the extension menu.

The menu contains the currently indexed notes followed by several actions.

### Open a note

Click a note title to open that note in GNOME Notes.

The extension uses the GNOME Notes Shell search provider to activate the selected note. Both local notes and notes synchronized through GNOME Online Accounts are supported.

### Refresh Notes

**Refresh Notes** reloads the current note list from the existing GNOME Notes Tracker database.

Use this action after:

* creating a note
* editing a note title
* synchronizing new Nextcloud notes
* moving a note between notebooks
* changing the note list in GNOME Notes

Refreshing is fast and does not restart GNOME Notes or rebuild its database.

Internally, the extension queries:

```text
~/.cache/bijiben/tracker3
```

using TinySPARQL.

The refresh action updates the panel list from the current state of that index.

### Rebuild Notes Index

**Rebuild Notes Index** performs a more extensive repair of the GNOME Notes index.

Use this action when notes that have already been deleted still appear in the panel after using **Refresh Notes**.

This may happen because GNOME Notes can leave obsolete resources in its local Tracker database. The GNOME Notes application and the Nextcloud server may no longer contain the deleted notes, while their old Tracker entries are still present.

The rebuild action:

1. closes GNOME Notes
2. stops the GNOME Notes Shell search provider
3. moves the existing Tracker databases into timestamped backup directories
4. removes older backup directories
5. starts GNOME Notes again
6. waits for GNOME Notes to recreate and synchronize its index
7. reloads the panel note list several times

The affected cache directories are:

```text
~/.cache/bijiben/tracker3
~/.cache/bijiben-shell-search-provider/tracker3
```

The actual local note files are not deleted. They remain stored under:

```text
~/.local/share/bijiben
```

Nextcloud notes also remain stored on the Nextcloud server.

The rebuild operation only replaces local cache and index data.

After starting a rebuild, GNOME Notes may require a few seconds to synchronize the complete note list. The extension automatically attempts to reload the index after approximately 3, 8 and 15 seconds.

### Refresh or rebuild?

Use **Refresh Notes** for normal updates.

Use **Rebuild Notes Index** only when refreshing does not remove obsolete entries.

| Situation                                       | Recommended action  |
| ----------------------------------------------- | ------------------- |
| A new note was created                          | Refresh Notes       |
| A title was changed                             | Refresh Notes       |
| A new Nextcloud note was synchronized           | Refresh Notes       |
| A deleted note still appears                    | Rebuild Notes Index |
| The list appears outdated after synchronization | Refresh Notes first |
| Refreshing does not fix the list                | Rebuild Notes Index |

## How it works

GNOME Notes stores its indexed note metadata in a private Tracker database.

The extension runs a TinySPARQL query against:

```text
~/.cache/bijiben/tracker3
```

The query returns:

* Tracker resource identifier
* note title
* local path or Nextcloud URL
* data source
* last modification date

Notes are ordered by their last modification date.

Local Trash entries are excluded by filtering URLs containing:

```text
/.Trash/
```

The extension also checks whether local `.note` files still exist before displaying them.

Cloud notes cannot be validated through the local filesystem. When stale cloud resources remain in Tracker, the index rebuild action is required.

## Project structure

```text
gnome-notes-panel@nordcomputer/
├── docs/
│   ├── screenshot-menu.png
│   └── screenshot-panel.png
├── extension.js
├── metadata.json
├── rebuild-index.sh
├── stylesheet.css
├── README.md
├── po/
│   ├── de.po
│   └── gnome-notes-panel@nordcomputer.pot
└── locale/
    └── de/
        └── LC_MESSAGES/
            └── gnome-notes-panel@nordcomputer.mo
```

## Translation

The source language is English.

Translatable strings in `extension.js` use the GNOME gettext helper:

```javascript
_('Refresh Notes')
```

Regenerate the POT file after adding or changing translatable strings:

```bash
xgettext \
    --from-code=UTF-8 \
    --language=JavaScript \
    --keyword=_ \
    --package-name='GNOME Notes Panel' \
    --package-version='1.0' \
    --copyright-holder='Mario Maresch' \
    --msgid-bugs-address='notes-extension@nordcomputer.de' \
    --output=po/gnome-notes-panel@nordcomputer.pot \
    extension.js
```

Update the German PO file:

```bash
msgmerge \
    --update \
    --backup=none \
    po/de.po \
    po/gnome-notes-panel@nordcomputer.pot
```

Check the translation:

```bash
msgfmt \
    --check \
    --check-header \
    po/de.po
```

Compile the MO file:

```bash
msgfmt \
    po/de.po \
    --output-file=locale/de/LC_MESSAGES/gnome-notes-panel@nordcomputer.mo
```

The gettext domain in `metadata.json` must match the MO filename:

```json
"gettext-domain": "gnome-notes-panel@nordcomputer"
```

## Development

Reloading GNOME Shell extensions depends on the active display server.

On X11, GNOME Shell can often be restarted with:

```text
Alt+F2
r
Enter
```

On Wayland, log out and back in after changing the extension.

The extension can be disabled and enabled from a terminal:

```bash
gnome-extensions disable gnome-notes-panel@nordcomputer
gnome-extensions enable gnome-notes-panel@nordcomputer
```

View GNOME Shell logs with:

```bash
journalctl --user \
    -f \
    -o cat \
    /usr/bin/gnome-shell
```

A broader user-session log can be viewed with:

```bash
journalctl --user -f
```

## Compatibility

The currently declared GNOME Shell versions are:

```json
"shell-version": [
    "48",
    "49",
    "50"
]
```

Compatibility declarations indicate versions on which the extension is intended to run. They do not guarantee compatibility without testing.

Additional GNOME Shell versions should only be added after verifying that the extension loads and that the following functions work:

* opening the panel menu
* querying notes through TinySPARQL
* opening local notes
* opening Nextcloud notes
* refreshing the note list
* rebuilding the note index

## Known limitations

* The extension depends on GNOME Notes' internal Tracker database layout.
* GNOME Notes may leave obsolete cloud-note resources in Tracker.
* Deleted cloud notes cannot be reliably detected through the local filesystem.
* Rebuilding the index temporarily restarts GNOME Notes.
* The extension currently depends on the `tinysparql` command-line utility.
* Only German and English are currently included.
* The implementation is specifically designed for GNOME Notes / Bijiben.

## Safety of the rebuild action

The rebuild script does not delete the current Tracker database immediately.

It renames the existing database directories using a timestamp:

```text
tracker3.backup-YYYYMMDD-HHMMSS
```

The two newest backups are retained. Older backups are removed automatically.

The rebuild action does not delete:

* local `.note` files
* Nextcloud notes
* GNOME Online Accounts
* Nextcloud credentials
* application settings

## Uninstallation

Disable the extension:

```bash
gnome-extensions disable gnome-notes-panel@nordcomputer
```

Remove the extension directory:

```bash
rm -rf \
    ~/.local/share/gnome-shell/extensions/gnome-notes-panel@nordcomputer
```

Optional Tracker backup directories created by the rebuild script can be removed separately:

```bash
rm -rf ~/.cache/bijiben/tracker3.backup-*
rm -rf ~/.cache/bijiben-shell-search-provider/tracker3.backup-*
```

Do not remove the active `tracker3` directories unless you intentionally want GNOME Notes to rebuild its indexes.

## License

Add the selected license here.

For example:

```text
GPL-3.0-or-later
```

## Author

Mario Maresch
