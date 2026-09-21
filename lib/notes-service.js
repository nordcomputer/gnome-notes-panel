// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Mario Maresch

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

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

export class NotesService {
    constructor(untitledNoteLabel = 'Untitled Note') {
        this._untitledNoteLabel = untitledNoteLabel;
        this._queryProcess = null;
    }

    get databasePath() {
        const tracker4 = GLib.build_filenamev([
            GLib.get_user_data_dir(),
            'bijiben',
            'tracker4',
        ]);

        if (GLib.file_test(tracker4, GLib.FileTest.IS_DIR))
            return tracker4;

        const orgNotes = GLib.build_filenamev([
            GLib.get_user_cache_dir(),
            'org.gnome.Notes',
            'tracker3',
        ]);

        if (GLib.file_test(orgNotes, GLib.FileTest.IS_DIR))
            return orgNotes;

        return GLib.build_filenamev([
            GLib.get_user_cache_dir(),
            'bijiben',
            'tracker3',
        ]);
    }

    get isLoading() {
        return this._queryProcess !== null;
    }

    databaseExists() {
        return GLib.file_test(
            this.databasePath,
            GLib.FileTest.IS_DIR
        );
    }

    async loadNotes() {
        if (this._queryProcess) {
            throw new Error(
                'A TinySPARQL query is already running'
            );
        }

        const executable =
            GLib.find_program_in_path('tinysparql');

        if (!executable) {
            const error = new Error(
                'TinySPARQL could not be found'
            );

            error.code = 'TINYS_PARQL_NOT_FOUND';
            throw error;
        }

        if (!this.databaseExists()) {
            const error = new Error(
                'The notes index is not ready yet'
            );

            error.code = 'DATABASE_NOT_READY';
            throw error;
        }

        try {
            this._queryProcess = Gio.Subprocess.new(
                [
                    executable,
                    'query',
                    '--database',
                    this.databasePath,
                    '--query',
                    NOTES_QUERY,
                ],
                Gio.SubprocessFlags.STDOUT_PIPE |
                Gio.SubprocessFlags.STDERR_PIPE
            );

            const [
                successful,
                stdout,
                stderr,
            ] = await this._communicateUtf8(
                this._queryProcess
            );

            if (!successful) {
                throw new Error(
                    stderr?.trim() ||
                    'TinySPARQL returned an error'
                );
            }

            return this._parseQueryOutput(stdout);
        } finally {
            this._queryProcess = null;
        }
    }

    createSignature(notes) {
        return JSON.stringify(
            notes.map(note => [
                note.resource,
                note.title,
                note.url,
                note.source,
                note.modified,
            ])
        );
    }

    cancel() {
        if (!this._queryProcess)
            return;

        try {
            if (!this._queryProcess.get_if_exited())
                this._queryProcess.force_exit();
        } catch (error) {
            console.warn(
                'GNOME Notes Panel: Could not terminate ' +
                `TinySPARQL: ${error}`
            );
        }

        this._queryProcess = null;
    }

    destroy() {
        this.cancel();
        this._untitledNoteLabel = null;
    }

    _communicateUtf8(process) {
        return new Promise((resolve, reject) => {
            process.communicate_utf8_async(
                null,
                null,
                (subprocess, result) => {
                    try {
                        resolve(
                            subprocess.communicate_utf8_finish(
                                result
                            )
                        );
                    } catch (error) {
                        reject(error);
                    }
                }
            );
        });
    }

    _parseQueryOutput(output) {
        if (typeof output !== 'string')
            return [];

        const notes = [];
        const seenUrls = new Set();

        for (const rawLine of output.split('\n')) {
            const line = rawLine.trim();

            if (
                !line ||
                this._countCharacter(line, '|') !== 4
            ) {
                continue;
            }

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
             * Hide stale local Tracker resources if their underlying
             * .note file no longer exists.
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
                title:
                    title ||
                    this._untitledNoteLabel,
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
                'GNOME Notes Panel: Could not decode ' +
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
}
