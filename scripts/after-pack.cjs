// Spouští electron-builder hned po zabalení (afterPack), před případným podpisem.
//
// 1. Electron fuses: vypne způsoby, jak pod jménem aplikace spustit libovolný kód
//    (ELECTRON_RUN_AS_NODE, NODE_OPTIONS, --inspect). Musí to být před podpisem, protože mění binárku.
// 2. macOS: aplikace bez certifikátu se podepíše ad hoc. Nepodepsanou arm64 aplikaci by macOS
//    po stažení odmítl jako „poškozenou“.
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses');

exports.default = async function afterPack(context) {
  const platform = context.electronPlatformName;
  // Univerzální build balí x64 a arm64 do *-temp složek; distribuuje se jen sloučená aplikace.
  if (platform === 'darwin' && context.appOutDir.endsWith('-temp')) return;
  const name = context.packager.appInfo.productFilename;
  const target =
    platform === 'darwin' ? path.join(context.appOutDir, `${name}.app`) : path.join(context.appOutDir, `${name}.exe`);

  await flipFuses(target, {
    version: FuseVersion.V1,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
  });

  if (platform === 'darwin') execFileSync('codesign', ['--force', '--deep', '--sign', '-', target], { stdio: 'inherit' });
};
