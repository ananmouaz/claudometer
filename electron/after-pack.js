// electron-builder skips node_modules when copying extraResources, but the Next
// standalone server needs its bundled node_modules at runtime. Copy them into
// the packaged app/Contents/Resources/app-server after packing.
const fs = require("fs");
const path = require("path");

exports.default = async function afterPack(context) {
  const { appOutDir, packager } = context;
  const appName = packager.appInfo.productFilename;
  const src = path.join(process.cwd(), ".next", "standalone", "node_modules");
  const dest = path.join(
    appOutDir,
    `${appName}.app`,
    "Contents",
    "Resources",
    "app-server",
    "node_modules",
  );
  await fs.promises.rm(dest, { recursive: true, force: true });
  await fs.promises.cp(src, dest, { recursive: true });
  console.log(`[afterPack] copied standalone node_modules → ${dest}`);
};
