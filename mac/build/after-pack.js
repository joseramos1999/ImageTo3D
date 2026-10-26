// Without an Apple Developer ID the app is not signed, but on Apple Silicon macOS refuses to
// run code with no signature at all ("ImageTo3D is damaged"). An ad-hoc signature (identity
// "-") satisfies that; Gatekeeper still asks once, the first time the app is opened.
const { execFileSync } = require('child_process');
const path = require('path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--verbose=2', app], { stdio: 'inherit' });
};
