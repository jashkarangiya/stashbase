#!/bin/zsh
set -euo pipefail

APP_NAME="StashBase.app"
SOURCE_APP="${0:A:h}/${APP_NAME}"
TARGET_APP="/Applications/${APP_NAME}"
SIGN_SCRIPT="${0:A:h}/.sign-macos-app.sh"

pause_and_exit() {
  local code="${1:-1}"
  echo ""
  read -r "?Press Enter to close..."
  exit "$code"
}

if [[ ! -d "$SOURCE_APP" ]]; then
  echo "Cannot find ${APP_NAME} next to this installer script."
  echo "Run this script from the mounted StashBase DMG."
  pause_and_exit 1
fi

if [[ ! -f "$SIGN_SCRIPT" ]]; then
  echo "Cannot find the StashBase signing helper next to this installer script."
  echo "Run this script from the mounted StashBase DMG."
  pause_and_exit 1
fi

HELPER="$(/usr/bin/mktemp -t stashbase-install)"
trap '/bin/rm -f "$HELPER"' EXIT
/bin/cat > "$HELPER" <<'EOS'
#!/bin/zsh
set -euo pipefail

SOURCE_APP="$1"
TARGET_APP="$2"
SIGN_SCRIPT="$3"
stage="starting"

fail() {
  local code="$?"
  echo "[StashBase install] failed while ${stage}" >&2
  echo "[StashBase install] source: ${SOURCE_APP}" >&2
  echo "[StashBase install] target: ${TARGET_APP}" >&2
  exit "$code"
}
trap fail ERR

if [[ -d "$TARGET_APP" ]]; then
  stage="removing the previous app from /Applications"
  /bin/rm -rf "$TARGET_APP"
fi

stage="copying StashBase.app without quarantine attributes"
/usr/bin/ditto --noextattr --noacl --norsrc "$SOURCE_APP" "$TARGET_APP"
stage="clearing extended attributes"
/usr/bin/xattr -cr "$TARGET_APP" 2>/dev/null || true
stage="repairing the ad-hoc code signature"
/bin/zsh "$SIGN_SCRIPT" "$TARGET_APP"
stage="verifying the installed app bundle"
/usr/bin/codesign --verify --deep --strict "$TARGET_APP" >/dev/null 2>&1 || true
EOS

/bin/chmod +x "$HELPER"

if ! /usr/bin/osascript - "$HELPER" "$SOURCE_APP" "$TARGET_APP" "$SIGN_SCRIPT" <<'OSA'
on run argv
  set helperPath to item 1 of argv
  set sourcePath to item 2 of argv
  set targetPath to item 3 of argv
  set signPath to item 4 of argv
  do shell script quoted form of helperPath & " " & quoted form of sourcePath & " " & quoted form of targetPath & " " & quoted form of signPath with administrator privileges
end run
OSA
then
  echo "StashBase install failed."
  echo "If you cancelled the administrator prompt, run Fix.sh again."
  echo "If it failed during copying or signing, make sure StashBase is not running and try again."
  pause_and_exit 1
fi

/usr/bin/open "$TARGET_APP"
