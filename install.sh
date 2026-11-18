#!/usr/bin/env bash
# Installs SessionBrain for this user, or removes it with --uninstall:
#   - sessionbrain-app (the hub and the window, built from app/) and the `sessionbrain` command in ~/.local/bin
#   - the hub as a systemd user service, started now and at login
#   - the app launcher entry and its icon
#   - the /sessionbrain command, as a user-scope Claude Code plugin (from this folder as a marketplace);
#     it hooks nothing else: the map comes from the session's transcript
# Run it again after pulling changes: it updates everything in place.
set -euo pipefail

ROOT=$(cd "$(dirname "$(readlink -f "$0")")" && pwd)
BIN="$HOME/.local/bin"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
APPS="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
ICONS="${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor/scalable/apps"
UNIT=sessionbrain-hub.service

say() { printf '  %s\n' "$*"; }

if [[ ${1:-} == --uninstall ]]; then
  echo "Removing SessionBrain"
  systemctl --user disable --now "$UNIT" 2>/dev/null || true
  rm -f "$UNIT_DIR/$UNIT" "$BIN/sessionbrain" "$BIN/sessionbrain-app" "$APPS/sessionbrain.desktop" "$ICONS/sessionbrain.svg"
  systemctl --user daemon-reload
  claude plugin uninstall sessionbrain@sessionbrain --scope user 2>/dev/null || true
  claude plugin marketplace remove sessionbrain 2>/dev/null || true
  command -v update-desktop-database >/dev/null && update-desktop-database "$APPS" 2>/dev/null || true
  say "done"
  exit 0
fi

command -v cargo >/dev/null || { echo "building SessionBrain needs cargo" >&2; exit 1; }
command -v bun >/dev/null || { echo "building SessionBrain needs bun (it bundles the page)" >&2; exit 1; }
CLAUDE=$(command -v claude) || { echo "SessionBrain needs the claude CLI" >&2; exit 1; }

echo "Installing SessionBrain from $ROOT"

# SessionBrain was called workLens. Its old pieces are taken away, and the display options chosen in
# its window (skin, view, language) carried over to the new one.
OLD=worklens
if [[ -e "$UNIT_DIR/$OLD-hub.service" || -e "$BIN/$OLD-app" || -L "$BIN/$OLD" ]]; then
  systemctl --user disable --now "$OLD-hub.service" 2>/dev/null || true
  rm -f "$UNIT_DIR/$OLD-hub.service" "$BIN/$OLD" "$BIN/$OLD-app" "$APPS/$OLD.desktop" "$ICONS/$OLD.svg"
  systemctl --user daemon-reload
  claude plugin uninstall "$OLD@$OLD" --scope user >/dev/null 2>&1 || true
  claude plugin marketplace remove "$OLD" >/dev/null 2>&1 || true
  OLD_DATA="${XDG_DATA_HOME:-$HOME/.local/share}/$OLD-app/localstorage"
  NEW_DATA="${XDG_DATA_HOME:-$HOME/.local/share}/sessionbrain-app/localstorage"
  if [[ -d "$OLD_DATA" && ! -e "$NEW_DATA" ]]; then
    mkdir -p "$(dirname "$NEW_DATA")"
    cp -r "$OLD_DATA" "$NEW_DATA"
  fi
  rm -rf "${XDG_STATE_HOME:-$HOME/.local/state}/$OLD"
  say "replaced the old workLens install"
fi

mkdir -p "$BIN" "$UNIT_DIR" "$APPS" "$ICONS"
say "building sessionbrain-app (the hub and the window)"
cargo build --release --quiet --manifest-path "$ROOT/app/Cargo.toml"
# Copied, not linked: a rebuild in progress never pulls the binary from under the running hub.
install -m 755 "$ROOT/app/target/release/sessionbrain-app" "$BIN/sessionbrain-app.new"
mv -f "$BIN/sessionbrain-app.new" "$BIN/sessionbrain-app"
ln -sfn "$ROOT/bin/sessionbrain" "$BIN/sessionbrain"
say "commands: $BIN/sessionbrain, $BIN/sessionbrain-app"

sed -e "s#@APP@#$BIN/sessionbrain-app#g" -e "s#@CLAUDE@#$CLAUDE#g" "$ROOT/install/sessionbrain-hub.service.in" >"$UNIT_DIR/$UNIT"
systemctl --user daemon-reload
systemctl --user enable "$UNIT" >/dev/null 2>&1
systemctl --user restart "$UNIT"
for _ in $(seq 50); do
  curl -fsS -m 1 "http://127.0.0.1:${SESSIONBRAIN_PORT:-$(uid=$(id -u); ((uid >= 1000 && uid < 3000)) && echo $((7317 + uid - 1000)) || echo 7317)}/healthz" >/dev/null 2>&1 && break
  sleep 0.1
done
systemctl --user is-active --quiet "$UNIT" && say "hub: running ($UNIT, starts at login)" || { echo "the hub did not start: journalctl --user -u $UNIT" >&2; exit 1; }

cp "$ROOT/install/sessionbrain.svg" "$ICONS/sessionbrain.svg"
sed -e "s#@BIN@#$BIN#g" "$ROOT/install/sessionbrain.desktop.in" >"$APPS/sessionbrain.desktop"
command -v update-desktop-database >/dev/null && update-desktop-database "$APPS" 2>/dev/null || true
say "launcher: SessionBrain"

if claude plugin marketplace list 2>/dev/null | grep -q '❯ sessionbrain\b\|^ *sessionbrain\b'; then
  claude plugin marketplace update sessionbrain >/dev/null
else
  claude plugin marketplace add "$ROOT" >/dev/null
fi
if claude plugin list 2>/dev/null | grep -q 'sessionbrain@sessionbrain'; then
  claude plugin update sessionbrain@sessionbrain --scope user >/dev/null
  say "mod: updated (new sessions pick it up)"
else
  claude plugin install sessionbrain@sessionbrain --scope user >/dev/null
  say "mod: installed (new sessions pick it up)"
fi

echo "Done. Open SessionBrain from the launcher, or type /sessionbrain in a Claude session."
