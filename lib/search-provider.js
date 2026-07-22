// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Mario Maresch

import Gio from 'gi://Gio';

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
    Gio.DBusProxy.makeProxyWrapper(
        SEARCH_PROVIDER_XML
    );

export class NotesSearchProvider {
    constructor() {
        this._proxy = null;
        this._connecting = false;
        this._destroyed = false;
    }

    get isConnected() {
        return this._proxy !== null;
    }

    get isConnecting() {
        return this._connecting;
    }

    connect() {
        if (this._destroyed) {
            return Promise.reject(
                new Error(
                    'The search provider has already been destroyed'
                )
            );
        }

        if (this._proxy)
            return Promise.resolve();

        if (this._connecting) {
            return Promise.reject(
                new Error(
                    'The search provider connection is already in progress'
                )
            );
        }

        this._connecting = true;

        return new Promise((resolve, reject) => {
            new SearchProviderProxy(
                Gio.DBus.session,
                SEARCH_PROVIDER_BUS_NAME,
                SEARCH_PROVIDER_OBJECT_PATH,
                (proxy, error) => {
                    this._connecting = false;

                    if (this._destroyed) {
                        reject(
                            new Error(
                                'The search provider was destroyed ' +
                                'during connection setup'
                            )
                        );

                        return;
                    }

                    if (error) {
                        this._proxy = null;

                        reject(
                            new Error(
                                'Could not create search-provider ' +
                                `proxy: ${error}`
                            )
                        );

                        return;
                    }

                    this._proxy = proxy;

                    console.debug(
                        'GNOME Notes Panel: Search provider connected'
                    );

                    resolve();
                }
            );
        });
    }

    async activate(
        identifier,
        terms = [],
        timestamp = 0
    ) {
        if (this._destroyed) {
            throw new Error(
                'The search provider has already been destroyed'
            );
        }

        if (
            typeof identifier !== 'string' ||
            identifier.length === 0
        ) {
            throw new TypeError(
                'A valid note identifier is required'
            );
        }

        if (!this._proxy)
            await this.connect();

        return new Promise((resolve, reject) => {
            this._proxy.ActivateResultRemote(
                identifier,
                terms,
                timestamp,
                (_result, error) => {
                    if (error) {
                        reject(
                            new Error(
                                'Could not activate note ' +
                                `${identifier}: ${error}`
                            )
                        );

                        return;
                    }

                    resolve();
                }
            );
        });
    }

    destroy() {
        this._destroyed = true;
        this._connecting = false;
        this._proxy = null;
    }
}
