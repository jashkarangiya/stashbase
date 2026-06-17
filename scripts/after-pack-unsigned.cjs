const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const signScript = path.join(root, 'scripts', 'sign-macos-app.sh');

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = path.join(context.appOutDir, appName);
  if (!fs.existsSync(appPath)) {
    throw new Error(`Expected macOS app bundle was not found: ${appPath}`);
  }

  // The repo lives under ~/Documents, which iCloud syncs. fileproviderd
  // tags bundle directories with FinderInfo / fileprovider xattrs that
  // `xattr -cr` cannot reliably strip (it re-applies them to tracked
  // inodes), and codesign refuses to sign with them present ("resource
  // fork, Finder information, or similar detritus not allowed"). A
  // `ditto --noextattr` clone writes fresh inodes carrying none of the
  // strippable attrs — only the kernel-applied com.apple.provenance
  // survives, which codesign tolerates. Clone, swap, then sign.
  const cleanPath = `${appPath}.clean`;
  fs.rmSync(cleanPath, { recursive: true, force: true });
  execFileSync('/usr/bin/ditto', ['--noextattr', '--noacl', '--norsrc', appPath, cleanPath], {
    stdio: 'inherit',
  });
  fs.rmSync(appPath, { recursive: true, force: true });
  fs.renameSync(cleanPath, appPath);

  // Ad-hoc signature is mandatory: Apple Silicon refuses to execute
  // completely unsigned binaries, "unsigned distribution" or not.
  execFileSync('/bin/zsh', [signScript, appPath], { stdio: 'inherit' });
};
