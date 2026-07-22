// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Mario Maresch

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const DEFAULT_DEBOUNCE_SECONDS = 2;

const TRACKER_FILES = new Set([
    'meta.db',
    'meta.db-wal',
    'meta.db-shm',
]);

export class TrackerMonitor {
    constructor({
        databasePath,
        onChanged,
        shouldDefer = null,
        debounceSeconds = DEFAULT_DEBOUNCE_SECONDS,
    }) {
        if (
            typeof databasePath !== 'string' ||
            databasePath.length === 0
        ) {
            throw new TypeError(
                'TrackerMonitor requires a database path'
            );
        }

        if (typeof onChanged !== 'function') {
            throw new TypeError(
                'TrackerMonitor requires an onChanged callback'
            );
        }

        if (
            shouldDefer !== null &&
            typeof shouldDefer !== 'function'
        ) {
            throw new TypeError(
                'TrackerMonitor shouldDefer must be a function or null'
            );
        }

        this._databasePath = databasePath;
        this._onChanged = onChanged;
        this._shouldDefer = shouldDefer;

        this._debounceSeconds =
            Math.max(1, debounceSeconds);

        this._monitor = null;
        this._monitorSignalId = 0;
        this._refreshTimeoutId = 0;

        this._running = false;
        this._destroyed = false;
    }

    get databasePath() {
        return this._databasePath;
    }

    get isRunning() {
        return this._running;
    }

    start() {
        if (this._destroyed)
            return false;

        this.stop();

        const databaseDirectory =
            Gio.File.new_for_path(
                this._databasePath
            );

        if (!databaseDirectory.query_exists(null)) {
            console.debug(
                'GNOME Notes Panel: Tracker directory ' +
                `does not exist yet: ${this._databasePath}`
            );

            return false;
        }

        try {
            this._monitor =
                databaseDirectory.monitor_directory(
                    Gio.FileMonitorFlags.WATCH_MOVES,
                    null
                );

            this._monitorSignalId =
                this._monitor.connect(
                    'changed',
                    (
                        _monitor,
                        file,
                        otherFile,
                        eventType
                    ) => {
                        this._handleChanged(
                            file,
                            otherFile,
                            eventType
                        );
                    }
                );

            this._running = true;

            console.debug(
                'GNOME Notes Panel: Monitoring Tracker ' +
                `directory: ${this._databasePath}`
            );

            return true;
        } catch (error) {
            console.error(
                'GNOME Notes Panel: Could not monitor ' +
                `Tracker directory: ${error}`
            );

            this._monitor = null;
            this._monitorSignalId = 0;
            this._running = false;

            return false;
        }
    }

    stop() {
        this._cancelScheduledRefresh();

        if (
            this._monitor &&
            this._monitorSignalId
        ) {
            try {
                this._monitor.disconnect(
                    this._monitorSignalId
                );
            } catch (error) {
                console.debug(
                    'GNOME Notes Panel: Could not disconnect ' +
                    `Tracker monitor: ${error}`
                );
            }
        }

        if (this._monitor) {
            try {
                this._monitor.cancel();
            } catch (error) {
                console.debug(
                    'GNOME Notes Panel: Could not cancel ' +
                    `Tracker monitor: ${error}`
                );
            }
        }

        this._monitor = null;
        this._monitorSignalId = 0;
        this._running = false;
    }

    restart() {
        return this.start();
    }

    destroy() {
        if (this._destroyed)
            return;

        this._destroyed = true;

        this.stop();

        this._databasePath = null;
        this._onChanged = null;
        this._shouldDefer = null;
    }

    _handleChanged(
        file,
        otherFile,
        _eventType
    ) {
        if (
            this._destroyed ||
            !this._running
        ) {
            return;
        }

        const filename =
            file?.get_basename() ?? '';

        const otherFilename =
            otherFile?.get_basename() ?? '';

        if (
            !TRACKER_FILES.has(filename) &&
            !TRACKER_FILES.has(otherFilename)
        ) {
            return;
        }

        this._scheduleRefresh();
    }

    _scheduleRefresh() {
        this._cancelScheduledRefresh();

        this._refreshTimeoutId =
            GLib.timeout_add_seconds(
                GLib.PRIORITY_DEFAULT,
                this._debounceSeconds,
                () => {
                    this._refreshTimeoutId = 0;

                    if (
                        this._destroyed ||
                        !this._running
                    ) {
                        return GLib.SOURCE_REMOVE;
                    }

                    /*
                     * A TinySPARQL query or reindex operation may already
                     * be running. Reschedule instead of starting another
                     * operation concurrently.
                     */
                    if (
                        this._shouldDefer?.() === true
                    ) {
                        this._scheduleRefresh();

                        return GLib.SOURCE_REMOVE;
                    }

                    try {
                        const result =
                            this._onChanged();

                        if (
                            result instanceof Promise
                        ) {
                            result.catch(error => {
                                console.error(
                                    'GNOME Notes Panel: Automatic ' +
                                    `refresh failed: ${error}`
                                );
                            });
                        }
                    } catch (error) {
                        console.error(
                            'GNOME Notes Panel: Automatic ' +
                            `refresh failed: ${error}`
                        );
                    }

                    return GLib.SOURCE_REMOVE;
                }
            );
    }

    _cancelScheduledRefresh() {
        if (!this._refreshTimeoutId)
            return;

        GLib.source_remove(
            this._refreshTimeoutId
        );

        this._refreshTimeoutId = 0;
    }
}
