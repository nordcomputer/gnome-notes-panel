#!/usr/bin/env

// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Mario Maresch

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import System from 'system';

const MAX_BACKUPS = 2;
const INDEX_CHECK_INTERVAL_MS = 2000;
const INDEX_CHECK_MAX_ATTEMPTS = 30;

const NOTE_COUNT_QUERY = `
SELECT (COUNT(?note) AS ?count)
WHERE {
    ?note
        a <http://tracker.api.gnome.org/ontology/v3/nfo#Note> ;
        <http://tracker.api.gnome.org/ontology/v3/nie#title> ?title .
}
`;

function formatTimestamp() {
    return GLib.DateTime
        .new_now_local()
        .format('%Y%m%d-%H%M%S');
}

function sleep(milliseconds) {
    return new Promise(resolve => {
        GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            milliseconds,
            () => {
                resolve();
                return GLib.SOURCE_REMOVE;
            }
        );
    });
}

function runCommand(argv, ignoreFailure = false) {
    try {
        const process = Gio.Subprocess.new(
            argv,
            Gio.SubprocessFlags.STDOUT_SILENCE |
            Gio.SubprocessFlags.STDERR_SILENCE
        );

        process.wait_check(null);
    } catch (error) {
        if (ignoreFailure)
            return;

        throw new Error(
            `Command failed: ${argv.join(' ')}: ${error.message}`
        );
    }
}

function moveTrackerDatabase(timestamp) {
    const tracker4 = GLib.build_filenamev([
        GLib.get_user_data_dir(),
        'bijiben',
        'tracker4',
    ]);

    const tracker3 = GLib.build_filenamev([
        GLib.get_user_cache_dir(),
        'bijiben',
        'tracker3',
    ]);

    const sourcePath = GLib.file_test(tracker4, GLib.FileTest.IS_DIR)
        ? tracker4
        : tracker3;

    const parentDir = GLib.path_get_dirname(sourcePath);
    const destinationPath = GLib.build_filenamev([
        parentDir,
        `tracker-backup-${timestamp}`,
    ]);

    const source = Gio.File.new_for_path(sourcePath);

    if (!source.query_exists(null))
        return;

    source.move(
        Gio.File.new_for_path(destinationPath),
        Gio.FileCopyFlags.NONE,
        null,
        null
    );

    console.log(
        `GNOME Notes Panel: Moved ${sourcePath} to ${destinationPath}`
    );
}

function deleteRecursively(file) {
    const fileType = file.query_file_type(
        Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
        null
    );

    if (fileType === Gio.FileType.DIRECTORY) {
        const enumerator = file.enumerate_children(
            'standard::name,standard::type',
            Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
            null
        );

        try {
            let info;

            while (
                (info = enumerator.next_file(null)) !== null
            ) {
                deleteRecursively(
                    file.get_child(info.get_name())
                );
            }
        } finally {
            enumerator.close(null);
        }
    }

    file.delete(null);
}

function findTrackerBackups() {
    const candidates = [
        GLib.build_filenamev([
            GLib.get_user_data_dir(),
            'bijiben',
        ]),
        GLib.build_filenamev([
            GLib.get_user_cache_dir(),
            'bijiben',
        ]),
    ];

    for (const dirPath of candidates) {
        const directory = Gio.File.new_for_path(dirPath);

        if (!directory.query_exists(null))
            continue;

        const backups = [];
        const enumerator = directory.enumerate_children(
            'standard::name,standard::type',
            Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
            null
        );

        if (!enumerator)
            continue;

        let info;
        while ((info = enumerator.next_file(null))) {
            const name = info.get_attribute_string('standard::name');
            if (name.startsWith('tracker-backup-')) {
                backups.push({
                    file: directory.get_child(name),
                    modified: info.get_attribute_uint64('time::modified'),
                });
            }
        }
        enumerator.close(null);

        if (backups.length > 0) {
            backups.sort(
                (left, right) => right.modified - left.modified
            );
            return backups;
        }
    }

    return [];
}

function removeOldBackups() {
    const backups = findTrackerBackups();

    for (const backup of backups.slice(MAX_BACKUPS)) {
        const path = backup.file.get_path();
        deleteRecursively(backup.file);
        console.log(
            `GNOME Notes Panel: Removed old backup ${path}`
        );
    }
}

function launchNotes() {
    const appInfo = Gio.DesktopAppInfo.new(
        'org.gnome.Notes.desktop'
    );

    if (!appInfo) {
        throw new Error(
            'GNOME Notes desktop application was not found'
        );
    }

    appInfo.launch([], null);

    console.log(
        'GNOME Notes Panel: GNOME Notes was started'
    );
}

function communicateUtf8(process) {
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

function parseNoteCount(output) {
    if (typeof output !== 'string')
        return 0;

    /*
     * TinySPARQL prints a localized heading followed by the result.
     * Select the first line containing only an integer.
     */
    for (const line of output.split('\n')) {
        const value = line.trim();

        if (!/^\d+$/.test(value))
            continue;

        return Number.parseInt(value, 10);
    }

    return 0;
}

async function queryNoteCount(
    tinysparqlExecutable,
    databasePath
) {
    const process = Gio.Subprocess.new(
        [
            tinysparqlExecutable,
            'query',
            '--database',
            databasePath,
            '--query',
            NOTE_COUNT_QUERY,
        ],
        Gio.SubprocessFlags.STDOUT_PIPE |
        Gio.SubprocessFlags.STDERR_PIPE
    );

    const [
        successful,
        stdout,
        stderr,
    ] = await communicateUtf8(process);

    if (!successful) {
        throw new Error(
            stderr?.trim() ||
            'TinySPARQL returned an error'
        );
    }

    return parseNoteCount(stdout);
}

async function waitForNotesIndex() {
    const tinysparqlExecutable =
        GLib.find_program_in_path('tinysparql');

    if (!tinysparqlExecutable) {
        throw new Error(
            'TinySPARQL could not be found'
        );
    }

    const tracker4Path = GLib.build_filenamev([
        GLib.get_user_data_dir(),
        'bijiben',
        'tracker4',
    ]);

    const databasePath = GLib.file_test(tracker4Path, GLib.FileTest.IS_DIR)
        ? tracker4Path
        : GLib.build_filenamev([
              GLib.get_user_cache_dir(),
              'bijiben',
              'tracker3',
          ]);

    const databaseDirectory =
        Gio.File.new_for_path(databasePath);

    for (
        let attempt = 1;
        attempt <= INDEX_CHECK_MAX_ATTEMPTS;
        attempt++
    ) {
        if (databaseDirectory.query_exists(null)) {
            try {
                const noteCount = await queryNoteCount(
                    tinysparqlExecutable,
                    databasePath
                );

                console.log(
                    'GNOME Notes Panel: Index check ' +
                    `${attempt}/${INDEX_CHECK_MAX_ATTEMPTS}: ` +
                    `${noteCount} note(s)`
                );

                if (noteCount > 0)
                    return noteCount;
            } catch (error) {
                /*
                 * The database may still be getting created, opened or
                 * migrated. A failed query during this phase is expected.
                 */
                console.debug(
                    'GNOME Notes Panel: Notes index is not ready: ' +
                    error.message
                );
            }
        } else {
            console.debug(
                'GNOME Notes Panel: Tracker database does not exist yet'
            );
        }

        await sleep(INDEX_CHECK_INTERVAL_MS);
    }

    throw new Error(
        'The notes index remained empty after 60 seconds'
    );
}

async function main() {
    const timestamp = formatTimestamp();

    const bijibenDir = GLib.file_test(
        GLib.build_filenamev([
            GLib.get_user_data_dir(),
            'bijiben',
            'tracker4',
        ]),
        GLib.FileTest.IS_DIR
    )
        ? GLib.build_filenamev([
              GLib.get_user_data_dir(),
              'bijiben',
          ])
        : GLib.build_filenamev([
              GLib.get_user_cache_dir(),
              'bijiben',
          ]);

    /*
     * pkill returns a non-zero status if no matching process exists.
     * That is harmless and deliberately ignored.
     */
    runCommand(
        [
            'pkill',
            '-x',
            'bijiben',
        ],
        true
    );

    runCommand(
        [
            'pkill',
            '-f',
            'bijiben-shell-search-provider',
        ],
        true
    );

    moveTrackerDatabase(timestamp);

    removeOldBackups();

    launchNotes();

    const noteCount =
        await waitForNotesIndex();

    console.log(
        'GNOME Notes Panel: Notes index is ready with ' +
        `${noteCount} note(s)`
    );
}

try {
    await main();
} catch (error) {
    console.error(
        'GNOME Notes Panel: Index rebuild failed: ' +
        error.message
    );

    System.exit(1);
}
