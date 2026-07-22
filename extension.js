// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Mario Maresch

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

import { NotesService } from './lib/notes-service.js';
import { TrackerMonitor } from './lib/tracker-monitor.js';
import { NotesSearchProvider } from './lib/search-provider.js';

const NotesIndicator = GObject.registerClass(
class NotesIndicator extends PanelMenu.Button {
    _init(extensionPath) {
        super._init(0.0, _('GNOME Notes Panel'));

        this._extensionPath = extensionPath;

        this._notesService = new NotesService(
            _('Untitled Note')
        );

        this._searchProvider = new NotesSearchProvider();

        this._trackerMonitor = new TrackerMonitor({
            databasePath: this._notesService.databasePath,

            onChanged: () => {
                console.debug(
                    'GNOME Notes Panel: Tracker changed; ' +
                    'checking note list'
                );

                return this._loadNotes({
                    background: true,
                });
            },

            shouldDefer: () =>
                this._loading ||
                this._reindexing ||
                this._destroyed,

            debounceSeconds: 2,
        });


        this._reindexProcess = null;

        this._loading = false;
        this._loadingInBackground = false;
        this._reindexing = false;
        this._loadedOnce = false;
        this._destroyed = false;

        this._notes = [];
        this._notesSignature = '';

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

        titleItem.add_style_class_name(
            'bijiben-panel-title'
        );

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
                if (isOpen && !this._loadedOnce) {
                    this._loadNotes({
                        forceRender: true,
                    });
                }
            }
        );

        this._searchProvider
            .connect()
            .catch(error => {
                console.error(
                    'GNOME Notes Panel: Could not connect ' +
                    `search provider: ${error}`
                );
            });
        this._trackerMonitor.start();
    }

    async _loadNotes({
        background = false,
        forceRender = false,
    } = {}) {
        if (
            this._destroyed ||
            this._loading ||
            this._reindexing
        ) {
            return;
        }

        this._loading = true;
        this._loadingInBackground = background;

        if (!background)
            this._showStatus(_('Loading notes…'));

        try {
            const notes =
                await this._notesService.loadNotes();

            if (this._destroyed)
                return;

            const signature =
                this._notesService.createSignature(notes);

            const notesChanged =
                signature !== this._notesSignature;

            this._loadedOnce = true;

            if (notesChanged || forceRender) {
                this._notes = notes;
                this._notesSignature = signature;

                this._showNotes();

                console.debug(
                    'GNOME Notes Panel: Note list changed; ' +
                    'menu was updated'
                );
            } else {
                console.debug(
                    'GNOME Notes Panel: Tracker changed, ' +
                    'but note list is unchanged'
                );
            }
        } catch (error) {
            if (this._destroyed)
                return;

            console.error(
                'GNOME Notes Panel: Could not load notes: ' +
                error
            );

            if (!background) {
                switch (error.code) {
                case 'TINYS_PARQL_NOT_FOUND':
                    this._showStatus(
                        _('TinySPARQL could not be found')
                    );
                    break;

                case 'DATABASE_NOT_READY':
                    this._showStatus(
                        _('The notes index is not ready yet')
                    );
                    break;

                default:
                    this._showStatus(
                        _('Notes could not be loaded')
                    );
                    break;
                }
            }
        } finally {
            this._loading = false;
            this._loadingInBackground = false;
        }
    }

    _rebuildIndex() {
        if (
            this._destroyed ||
            this._reindexing ||
            this._loading
        ) {
            return;
        }

        const helperPath = GLib.build_filenamev([
            this._extensionPath,
            'rebuild-index.js',
        ]);

        if (
            !GLib.file_test(
                helperPath,
                GLib.FileTest.IS_REGULAR
            )
        ) {
            console.error(
                'GNOME Notes Panel: Index rebuild helper ' +
                `was not found: ${helperPath}`
            );

            Main.notifyError(
                _('GNOME Notes Panel'),
                _(
                    'The index rebuild helper could not ' +
                    'be found'
                )
            );

            return;
        }

        const gjsExecutable =
            GLib.find_program_in_path('gjs');

        if (!gjsExecutable) {
            console.error(
                'GNOME Notes Panel: gjs was not found'
            );

            Main.notifyError(
                _('GNOME Notes Panel'),
                _('GJS could not be found')
            );

            return;
        }

        this._trackerMonitor.stop();

        this._reindexing = true;
        this._loadedOnce = false;
        this._notes = [];
        this._notesSignature = '';

        this._showStatus(
            _('Rebuilding notes index…')
        );

        try {
            this._reindexProcess = Gio.Subprocess.new(
                [
                    gjsExecutable,
                    '-m',
                    helperPath,
                ],
                Gio.SubprocessFlags.STDOUT_PIPE |
                Gio.SubprocessFlags.STDERR_PIPE
            );
        } catch (error) {
            this._reindexing = false;
            this._reindexProcess = null;

            console.error(
                'GNOME Notes Panel: Could not start ' +
                `index rebuild helper: ${error}`
            );

            this._trackerMonitor.start();

            this._showStatus(
                _('The notes index could not be rebuilt')
            );

            Main.notifyError(
                _('GNOME Notes Panel'),
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
                    ] = process.communicate_utf8_finish(
                        result
                    );
                } catch (error) {
                    this._finishReindexWithError(
                        'Index rebuild helper failed: ' +
                        error
                    );

                    return;
                }

                this._reindexProcess = null;
                this._reindexing = false;

                if (!successful) {
                    this._finishReindexWithError(
                        stderr?.trim() ||
                        stdout?.trim() ||
                        'Index rebuild helper returned an error'
                    );

                    return;
                }

                console.debug(
                    'GNOME Notes Panel: Index rebuild helper: ' +
                    `${stdout?.trim() || 'completed'}`
                );

                Main.notify(
                    _('GNOME Notes Panel'),
                    _('The notes index has been rebuilt')
                );

                this._trackerMonitor.start();

                this._notesSignature = '';
                this._loadedOnce = false;

                this._loadNotes({
                    forceRender: true,
                });
            }
        );
    }

    _finishReindexWithError(message) {
        this._reindexProcess = null;
        this._reindexing = false;

        console.error(
            `GNOME Notes Panel: ${message}`
        );

        this._trackerMonitor.start();

        this._showStatus(
            _('The notes index could not be rebuilt')
        );

        Main.notifyError(
            _('GNOME Notes Panel'),
            _('The notes index could not be rebuilt')
        );
    }

    _showNotes() {
        this._notesSection.removeAll();

        if (this._notes.length === 0) {
            this._showStatus(_('No notes found'));
            return;
        }

        for (const note of this._notes) {
            const item =
                new PopupMenu.PopupMenuItem(
                    note.title
                );

            item.connect('activate', () => {
                this._activateNote(note);
            });

            this._notesSection.addMenuItem(item);
        }
    }

    async _activateNote(note) {
        try {
            await this._searchProvider.activate(
                note.url,
                [],
                global.get_current_time()
            );
        } catch (error) {
            console.error(
                'GNOME Notes Panel: Could not open note ' +
                `${note.url}: ${error}`
            );

            Main.notifyError(
                _('GNOME Notes Panel'),
                _('The note could not be opened')
            );
        }
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
                _('GNOME Notes Panel'),
                _('GNOME Notes could not be found')
            );

            return;
        }

        try {
            appInfo.launch([], null);
        } catch (error) {
            console.error(
                'GNOME Notes Panel: Could not launch ' +
                `GNOME Notes: ${error}`
            );

            Main.notifyError(
                _('GNOME Notes Panel'),
                _('GNOME Notes could not be opened')
            );
        }
    }

    destroy() {
        this._destroyed = true;

        this._trackerMonitor?.destroy();
        this._notesService?.destroy();
        this._searchProvider?.destroy();

        if (
            this._reindexProcess &&
            !this._reindexProcess.get_if_exited()
        ) {
            try {
                this._reindexProcess.force_exit();
            } catch (error) {
                console.warn(
                    'GNOME Notes Panel: Could not terminate ' +
                    `index rebuild helper: ${error}`
                );
            }
        }
        this._trackerMonitor = null;
        this._notesService = null;
        this._reindexProcess = null;
        this._searchProvider = null;

        this._notes = [];
        this._notesSignature = '';
        this._extensionPath = null;

        super.destroy();
    }
});

export default class GnomeNotesPanelExtension extends Extension {
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