import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {
    Extension,
    gettext as _,
} from 'resource:///org/gnome/shell/extensions/extension.js';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

const SEARCH_PROVIDER_BUS_NAME =
    'org.gnome.Notes.SearchProvider';

const SEARCH_PROVIDER_OBJECT_PATH =
    '/org/gnome/Notes/SearchProvider';

const SEARCH_PROVIDER_XML = `
<node>
    <interface name="org.gnome.Shell.SearchProvider2">
        <method name="ActivateResult">
            <arg type="s" name="identifier" direction="in"/>
            <arg type="as" name="terms" direction="in"/>
            <arg type="u" name="timestamp" direction="in"/>
        </method>
    </interface>
</node>
`;

const SearchProviderProxy =
    Gio.DBusProxy.makeProxyWrapper(SEARCH_PROVIDER_XML);

const NOTES_QUERY = `
SELECT (
    CONCAT(
        ENCODE_FOR_URI(STR(?note)),
        '|',
        ENCODE_FOR_URI(STR(?title)),
        '|',
        ENCODE_FOR_URI(STR(?url)),
        '|',
        ENCODE_FOR_URI(COALESCE(STR(?source), '')),
        '|',
        ENCODE_FOR_URI(COALESCE(STR(?modified), ''))
    ) AS ?row
)
WHERE {
    ?note
        a <http://tracker.api.gnome.org/ontology/v3/nfo#Note> ;
        <http://tracker.api.gnome.org/ontology/v3/nie#title> ?title ;
        <http://tracker.api.gnome.org/ontology/v3/nie#url> ?url .

    OPTIONAL {
        ?note
            <http://tracker.api.gnome.org/ontology/v3/nie#dataSource>
            ?source .
    }

    OPTIONAL {
        ?note
            <http://tracker.api.gnome.org/ontology/v3/nie#contentLastModified>
            ?modified .
    }

    FILTER(
        !CONTAINS(
            STR(?url),
            '/.Trash/'
        )
    )
}
ORDER BY DESC(?modified)
`;

const NotesIndicator = GObject.registerClass(
class NotesIndicator extends PanelMenu.Button {
    _init(extensionPath) {
        super._init(0.0, _('Bijiben Panel'));

        this._extensionPath = extensionPath;

        this._searchProviderProxy = null;
        this._queryProcess = null;
        this._reindexProcess = null;

        this._loading = false;
        this._reindexing = false;
        this._loadedOnce = false;
        this._destroyed = false;

        this._notes = [];
        this._reindexTimeoutIds = new Set();

        const icon = new St.Icon({
            icon_name: 'org.gnome.Notes-symbolic',
            style_class: 'system-status-icon',
        });

        this.add_child(icon);

        const titleItem = new PopupMenu.PopupMenuItem(
            _('My Notes'),
            {
                reactive: false,
                can_focus: false,
            }
        );

        titleItem.add_style_class_name('bijiben-panel-title');
        this.menu.addMenuItem(titleItem);

        this.menu.addMenuItem(
            new PopupMenu.PopupSeparatorMenuItem()
        );

        this._notesSection =
            new PopupMenu.PopupMenuSection();

        this.menu.addMenuItem(this._notesSection);

        this._showStatus(
            _('Notes have not been loaded yet')
        );

        this.menu.addMenuItem(
            new PopupMenu.PopupSeparatorMenuItem()
        );

        const refreshItem =
            new PopupMenu.PopupMenuItem(
                _('Refresh Notes')
            );

        refreshItem.connect('activate', () => {
            this._loadedOnce = false;
            this._loadNotes();
        });

        this.menu.addMenuItem(refreshItem);

        const rebuildIndexItem =
            new PopupMenu.PopupMenuItem(
                _('Rebuild Notes Index')
            );

        rebuildIndexItem.connect('activate', () => {
            this._rebuildIndex();
        });

        this.menu.addMenuItem(rebuildIndexItem);

        const openItem =
            new PopupMenu.PopupMenuItem(
                _('Open Notes')
            );

        openItem.connect('activate', () => {
            this._openBijiben();
        });

        this.menu.addMenuItem(openItem);

        this.menu.connect(
            'open-state-changed',
            (_menu, isOpen) => {
                if (isOpen && !this._loadedOnce)
                    this._loadNotes();
            }
        );

        this._createSearchProviderProxy();
    }

    _createSearchProviderProxy() {
        new SearchProviderProxy(
            Gio.DBus.session,
            SEARCH_PROVIDER_BUS_NAME,
            SEARCH_PROVIDER_OBJECT_PATH,
            (proxy, error) => {
                if (this._destroyed)
                    return;

                if (error) {
                    console.error(
                        'Bijiben Panel: Could not create ' +
                        `search-provider proxy: ${error}`
                    );

                    this._searchProviderProxy = null;
                    return;
                }

                this._searchProviderProxy = proxy;
            }
        );
    }

    _loadNotes() {
        if (
            this._destroyed ||
            this._loading ||
            this._reindexing
        ) {
            return;
        }

        const executable =
            GLib.find_program_in_path('tinysparql');

        if (!executable) {
            console.error(
                'Bijiben Panel: tinysparql was not found'
            );

            this._showStatus(
                _('TinySPARQL could not be found')
            );

            return;
        }

        const databasePath = GLib.build_filenamev([
            GLib.get_user_cache_dir(),
            'bijiben',
            'tracker3',
        ]);

        if (
            !GLib.file_test(
                databasePath,
                GLib.FileTest.IS_DIR
            )
        ) {
            console.warn(
                'Bijiben Panel: Tracker database directory ' +
                `does not exist yet: ${databasePath}`
            );

            this._showStatus(
                _('The notes index is not ready yet')
            );

            return;
        }

        this._loading = true;
        this._showStatus(_('Loading notes…'));

        try {
            this._queryProcess = Gio.Subprocess.new(
                [
                    executable,
                    'query',
                    '--database',
                    databasePath,
                    '--query',
                    NOTES_QUERY,
                ],
                Gio.SubprocessFlags.STDOUT_PIPE |
                Gio.SubprocessFlags.STDERR_PIPE
            );
        } catch (error) {
            this._loading = false;
            this._queryProcess = null;

            console.error(
                'Bijiben Panel: Could not start ' +
                `TinySPARQL: ${error}`
            );

            this._showStatus(
                _('Notes could not be loaded')
            );

            return;
        }

        this._queryProcess.communicate_utf8_async(
            null,
            null,
            (process, result) => {
                if (this._destroyed)
                    return;

                let successful;
                let stdout;
                let stderr;

                try {
                    [
                        successful,
                        stdout,
                        stderr,
                    ] = process.communicate_utf8_finish(result);
                } catch (error) {
                    this._finishLoadingWithError(
                        `TinySPARQL failed: ${error}`
                    );

                    return;
                }

                this._queryProcess = null;
                this._loading = false;

                if (!successful) {
                    this._finishLoadingWithError(
                        stderr?.trim() ||
                        'TinySPARQL returned an error'
                    );

                    return;
                }

                try {
                    this._notes =
                        this._parseQueryOutput(stdout);

                    this._loadedOnce = true;
                    this._showNotes();
                } catch (error) {
                    console.error(
                        'Bijiben Panel: Could not parse ' +
                        `TinySPARQL output: ${error}`
                    );

                    this._showStatus(
                        _('The notes database returned invalid data')
                    );
                }
            }
        );
    }

    _rebuildIndex() {
        if (
            this._destroyed ||
            this._reindexing ||
            this._loading
        ) {
            return;
        }

        const scriptPath = GLib.build_filenamev([
            this._extensionPath,
            'rebuild-index.sh',
        ]);

        if (
            !GLib.file_test(
                scriptPath,
                GLib.FileTest.EXISTS
            )
        ) {
            console.error(
                'Bijiben Panel: Rebuild script was not found: ' +
                scriptPath
            );

            Main.notifyError(
                _('Bijiben Panel'),
                _('The rebuild script could not be found')
            );

            return;
        }

        if (
            !GLib.file_test(
                scriptPath,
                GLib.FileTest.IS_EXECUTABLE
            )
        ) {
            console.error(
                'Bijiben Panel: Rebuild script is not executable: ' +
                scriptPath
            );

            Main.notifyError(
                _('Bijiben Panel'),
                _('The rebuild script is not executable')
            );

            return;
        }

        this._cancelReindexTimeouts();

        this._reindexing = true;
        this._loadedOnce = false;
        this._notes = [];

        this._showStatus(
            _('Rebuilding notes index…')
        );

        try {
            this._reindexProcess = Gio.Subprocess.new(
                [scriptPath],
                Gio.SubprocessFlags.STDOUT_PIPE |
                Gio.SubprocessFlags.STDERR_PIPE
            );
        } catch (error) {
            this._reindexing = false;
            this._reindexProcess = null;

            console.error(
                'Bijiben Panel: Could not start rebuild script: ' +
                error
            );

            this._showStatus(
                _('The notes index could not be rebuilt')
            );

            return;
        }

        this._reindexProcess.communicate_utf8_async(
            null,
            null,
            (process, result) => {
                if (this._destroyed)
                    return;

                let successful;
                let stdout;
                let stderr;

                try {
                    [
                        successful,
                        stdout,
                        stderr,
                    ] = process.communicate_utf8_finish(result);
                } catch (error) {
                    this._finishReindexWithError(
                        `Rebuild script failed: ${error}`
                    );

                    return;
                }

                this._reindexProcess = null;
                this._reindexing = false;

                if (!successful) {
                    this._finishReindexWithError(
                        stderr?.trim() ||
                        stdout?.trim() ||
                        'Rebuild script returned an error'
                    );

                    return;
                }

                Main.notify(
                    _('Bijiben Panel'),
                    _('The notes index is being rebuilt')
                );

                this._showStatus(
                    _('Waiting for the notes index…')
                );

                this._scheduleReloadAfterReindex();
            }
        );
    }

    _scheduleReloadAfterReindex() {
        /*
         * Bijiben creates the database quickly, but synchronising the
         * Nextcloud notes may take longer. The list is therefore loaded
         * several times after rebuilding the index.
         */
        for (const delay of [3, 8, 15]) {
            let timeoutId = 0;

            timeoutId = GLib.timeout_add_seconds(
                GLib.PRIORITY_DEFAULT,
                delay,
                () => {
                    this._reindexTimeoutIds.delete(timeoutId);

                    if (this._destroyed)
                        return GLib.SOURCE_REMOVE;

                    this._loadedOnce = false;
                    this._loadNotes();

                    return GLib.SOURCE_REMOVE;
                }
            );

            this._reindexTimeoutIds.add(timeoutId);
        }
    }

    _cancelReindexTimeouts() {
        for (const timeoutId of this._reindexTimeoutIds) {
            GLib.source_remove(timeoutId);
        }

        this._reindexTimeoutIds.clear();
    }

    _finishReindexWithError(message) {
        this._reindexProcess = null;
        this._reindexing = false;

        console.error(
            `Bijiben Panel: ${message}`
        );

        this._showStatus(
            _('The notes index could not be rebuilt')
        );

        Main.notifyError(
            _('Bijiben Panel'),
            _('The notes index could not be rebuilt')
        );
    }

    _parseQueryOutput(output) {
        if (typeof output !== 'string')
            return [];

        const notes = [];
        const seenUrls = new Set();

        for (const rawLine of output.split('\n')) {
            const line = rawLine.trim();

            if (!line || this._countCharacter(line, '|') !== 4)
                continue;

            const [
                encodedResource,
                encodedTitle,
                encodedUrl,
                encodedSource,
                encodedModified,
            ] = line.split('|');

            const resource =
                this._decodeQueryValue(encodedResource);

            const title =
                this._decodeQueryValue(encodedTitle);

            const url =
                this._decodeQueryValue(encodedUrl);

            const source =
                this._decodeQueryValue(encodedSource);

            const modified =
                this._decodeQueryValue(encodedModified);

            if (!resource || !url)
                continue;

            /*
             * Verwaiste lokale Tracker-Einträge ausblenden, falls die
             * eigentliche .note-Datei nicht mehr existiert.
             */
            if (
                source === 'local:local' &&
                !GLib.file_test(
                    url,
                    GLib.FileTest.EXISTS
                )
            ) {
                continue;
            }

            if (seenUrls.has(url))
                continue;

            seenUrls.add(url);

            notes.push({
                resource,
                title: title || _('Untitled Note'),
                url,
                source,
                modified,
            });
        }

        return notes;
    }

    _decodeQueryValue(value) {
        if (!value)
            return '';

        try {
            return decodeURIComponent(value);
        } catch (error) {
            console.warn(
                'Bijiben Panel: Could not decode ' +
                `query value "${value}": ${error}`
            );

            return value;
        }
    }

    _countCharacter(value, character) {
        let count = 0;

        for (const currentCharacter of value) {
            if (currentCharacter === character)
                count++;
        }

        return count;
    }

    _showNotes() {
        this._notesSection.removeAll();

        if (this._notes.length === 0) {
            this._showStatus(_('No notes found'));
            return;
        }

        for (const note of this._notes) {
            const item =
                new PopupMenu.PopupMenuItem(note.title);

            item.connect('activate', () => {
                this._activateNote(note);
            });

            this._notesSection.addMenuItem(item);
        }
    }

    _activateNote(note) {
        if (!this._searchProviderProxy) {
            console.error(
                'Bijiben Panel: Search-provider proxy ' +
                'is not available'
            );

            Main.notifyError(
                _('Bijiben Panel'),
                _('The note could not be opened')
            );

            return;
        }

        this._searchProviderProxy.ActivateResultRemote(
            note.url,
            [],
            global.get_current_time(),
            (_result, error) => {
                if (!error)
                    return;

                console.error(
                    'Bijiben Panel: Could not open note ' +
                    `${note.url}: ${error}`
                );

                Main.notifyError(
                    _('Bijiben Panel'),
                    _('The note could not be opened')
                );
            }
        );
    }

    _finishLoadingWithError(message) {
        this._queryProcess = null;
        this._loading = false;

        console.error(
            `Bijiben Panel: ${message}`
        );

        this._showStatus(
            _('Notes could not be loaded')
        );
    }

    _showStatus(message) {
        this._notesSection.removeAll();

        const item = new PopupMenu.PopupMenuItem(
            message,
            {
                reactive: false,
                can_focus: false,
            }
        );

        this._notesSection.addMenuItem(item);
    }

    _openBijiben() {
        const appInfo = Gio.DesktopAppInfo.new(
            'org.gnome.Notes.desktop'
        );

        if (!appInfo) {
            Main.notifyError(
                _('Bijiben Panel'),
                _('GNOME Notes could not be found')
            );

            return;
        }

        try {
            appInfo.launch([], null);
        } catch (error) {
            console.error(
                'Bijiben Panel: Could not launch ' +
                `GNOME Notes: ${error}`
            );

            Main.notifyError(
                _('Bijiben Panel'),
                _('GNOME Notes could not be opened')
            );
        }
    }

    destroy() {
        this._destroyed = true;

        this._cancelReindexTimeouts();

        if (
            this._queryProcess &&
            !this._queryProcess.get_if_exited()
        ) {
            try {
                this._queryProcess.force_exit();
            } catch (error) {
                console.warn(
                    'Bijiben Panel: Could not terminate ' +
                    `TinySPARQL: ${error}`
                );
            }
        }

        if (
            this._reindexProcess &&
            !this._reindexProcess.get_if_exited()
        ) {
            try {
                this._reindexProcess.force_exit();
            } catch (error) {
                console.warn(
                    'Bijiben Panel: Could not terminate ' +
                    `rebuild script: ${error}`
                );
            }
        }

        this._queryProcess = null;
        this._reindexProcess = null;
        this._searchProviderProxy = null;

        this._notes = [];
        this._extensionPath = null;

        super.destroy();
    }
});

export default class BijibenPanelExtension extends Extension {
    enable() {
        this._indicator = new NotesIndicator(
            this.path
        );

        Main.panel.addToStatusArea(
            this.uuid,
            this._indicator
        );
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}