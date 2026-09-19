echo "===== 1. Installierte Pakete ====="
pacman -Qs bijiben 2>/dev/null
pacman -Qs gnome-notes 2>/dev/null
pacman -Qs tracker 2>/dev/null
pacman -Qs tinysparql 2>/dev/null
echo ""

echo "===== 2. tinysparql Binary ====="
which tinysparql 2>/dev/null || echo "NICHT gefunden"
tinysparql --version 2>&1 || true
echo ""

echo "===== 3. ~/.local/share/bijiben ====="
ls -laR ~/.local/share/bijiben/ 2>/dev/null || echo "existiert NICHT"
echo ""

echo "===== 4. ~/.cache/bijiben ====="
ls -laR ~/.cache/bijiben/ 2>/dev/null || echo "existiert NICHT"
echo ""

echo "===== 5. Alle SQLite-Dateien unter bijiben ====="
find ~/.local/share/bijiben ~/.cache/bijiben \
  \( -name '*.sqlite*' -o -name '*.db' \) 2>/dev/null
echo ""

echo "===== 6. Laufende bijiben/tracker-Prozesse ====="
ps aux | grep -iE 'bijiben|tracker' | grep -v grep
echo ""

echo "===== 7. GNOME Notes starten, 10 s warten, prüfen ====="
org.gnome.Notes &
sleep 10
echo "--- Prozesse ---"
ps aux | grep -iE 'bijiben|tracker' | grep -v grep
echo "--- ~/.local/share/bijiben nach Start ---"
ls -laR ~/.local/share/bijiben/ 2>/dev/null || echo "existiert NICHT"
echo "--- ~/.cache/bijiben nach Start ---"
ls -laR ~/.cache/bijiben/ 2>/dev/null || echo "existiert NICHT"
echo "--- SQLite nach Start ---"
find ~/.local/share/bijiben ~/.cache/bijiben \
  \( -name '*.sqlite*' -o -name '*.db' \) 2>/dev/null
echo ""

echo "===== 8. Direkte tinysparql-Abfrage ====="
for DB in \
  "$HOME/.local/share/bijiben/tracker4" \
  "$HOME/.cache/bijiben/tracker3" \
  "$HOME/.local/share/bijiben/tracker3" \
  "$HOME/.cache/bijiben/tracker4"; do
  if [ -d "$DB" ]; then
    echo "--- Pfad: $DB ---"
    tinysparql query --database "$DB" \
      --query "SELECT (COUNT(?n) AS ?c) WHERE { ?n a <http://tracker.api.gnome.org/ontology/v3/nfo#Note> }" \
      2>&1
  fi
done
echo ""

echo "===== 9. GNOME Notes beenden ====="
pkill -x bijiben 2>/dev/null
pkill -f bijiben-shell-search-provider 2>/dev/null
echo "fertig teil 1"
