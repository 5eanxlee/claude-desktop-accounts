#!/bin/zsh
# ./build.sh          compile, run the self-tests, assemble build/Claude Accounts.app
# ./build.sh install  also install it and open it
#   APP_DIR=…         install into this folder (default: /Applications if writable, else ~/Applications)
#   CDA_NO_OPEN=1     do not open the app after installing
set -e
cd "${0:A:h}"
mkdir -p build
xcrun swiftc -swift-version 5 -O -framework AppKit -framework Security -lsqlite3 \
  Identity.swift Crypto.swift Usage.swift Quota.swift ClaudeData.swift Store.swift Switcher.swift Sync.swift App.swift Tests.swift main.swift \
  -o build/ClaudeAccounts
build/ClaudeAccounts --self-test

app="build/Claude Accounts.app"
rm -rf "$app"
mkdir -p "$app/Contents/MacOS"
cp build/ClaudeAccounts "$app/Contents/MacOS/ClaudeAccounts"
cat > "$app/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>ClaudeAccounts</string>
  <key>CFBundleIdentifier</key><string>local.claude-accounts</string>
  <key>CFBundleName</key><string>Claude Accounts</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
</dict>
</plist>
PLIST
codesign --force --sign - "$app" >/dev/null 2>&1

if [[ "$1" == "install" ]]; then
  if [[ -n "$APP_DIR" ]]; then dest="$APP_DIR"
  elif [[ -w /Applications ]]; then dest="/Applications"
  else dest="$HOME/Applications"; fi
  mkdir -p "$dest"
  pkill -f "$dest/Claude Accounts.app/Contents/MacOS/ClaudeAccounts" 2>/dev/null || true
  rm -rf "$dest/Claude Accounts.app"
  ditto "$app" "$dest/Claude Accounts.app"
  echo "Installed $dest/Claude Accounts.app"
  [[ -n "$CDA_NO_OPEN" ]] || open "$dest/Claude Accounts.app"
fi
