#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Mario Maresch
set -euo pipefail

timestamp="$(date +%Y%m%d-%H%M%S)"

backup_tracker_database() {
    local cache_dir="$1"
    local tracker_dir="$cache_dir/tracker3"
    local backup_dir="$cache_dir/tracker3.backup-$timestamp"

    if [[ -d "$tracker_dir" ]]; then
        mv -- "$tracker_dir" "$backup_dir"
    fi
}

remove_old_backups() {
    local cache_dir="$1"

    mapfile -d '' backups < <(
        find "$cache_dir" \
            -maxdepth 1 \
            -type d \
            -name 'tracker3.backup-*' \
            -printf '%T@ %p\0' 2>/dev/null |
        sort -zrn
    )

    if (( ${#backups[@]} <= 2 )); then
        return
    fi

    for entry in "${backups[@]:2}"; do
        local backup_path="${entry#* }"
        rm -rf -- "$backup_path"
    done
}

pkill -x bijiben 2>/dev/null || true
pkill -f 'bijiben-shell-search-provider' 2>/dev/null || true

backup_tracker_database \
    "$HOME/.cache/bijiben"

backup_tracker_database \
    "$HOME/.cache/bijiben-shell-search-provider"

remove_old_backups \
    "$HOME/.cache/bijiben"

remove_old_backups \
    "$HOME/.cache/bijiben-shell-search-provider"

gtk-launch org.gnome.Notes