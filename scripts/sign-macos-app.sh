#!/bin/zsh
set -euo pipefail

APP_PATH="${1:-}"

if [[ -z "$APP_PATH" || ! -d "$APP_PATH" ]]; then
  echo "usage: sign-macos-app.sh /path/to/App.app" >&2
  exit 2
fi

sign_one() {
  local target="$1"
  local output
  if output=$(/usr/bin/codesign --force --sign - "$target" 2>&1); then
    return 0
  fi
  echo "[sign-macos-app] codesign failed: $target" >&2
  echo "$output" >&2
  return 1
}

while IFS= read -r file; do
  parent="${file:h}"
  if [[ "$parent" == *.framework && -d "$parent/Versions" ]]; then
    continue
  fi
  if /usr/bin/file -b "$file" | /usr/bin/grep -q "Mach-O"; then
    sign_one "$file"
  fi
done < <(/usr/bin/find "$APP_PATH" -type f -print)

while IFS= read -r nested_app; do
  [[ "$nested_app" == "$APP_PATH" ]] && continue
  sign_one "$nested_app"
done < <(/usr/bin/find "$APP_PATH" -type d -name "*.app" -print | /usr/bin/sort -r)

sign_one "$APP_PATH"
