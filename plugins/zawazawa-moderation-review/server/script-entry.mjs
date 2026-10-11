import { realpath, stat } from "node:fs/promises";
import { normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Compare file identity so Windows short names, case and filesystem aliases work. */
export async function isMainModule(moduleUrl, argv = process.argv) {
  if (typeof argv?.[1] !== "string" || !argv[1]) return false;
  try {
    const invokedPath = resolve(argv[1]);
    const modulePath = fileURLToPath(moduleUrl);
    const [invoked, module] = await Promise.all([
      stat(invokedPath, { bigint: true }), stat(modulePath, { bigint: true }),
    ]);
    if (!invoked.isFile() || !module.isFile()) return false;
    if (invoked.ino !== 0n && module.ino !== 0n) {
      return invoked.dev === module.dev && invoked.ino === module.ino;
    }
    // Some filesystems do not expose stable inode identities.
    const paths = await Promise.all([realpath(invokedPath), realpath(modulePath)]);
    const canonical = (path) => {
      const normalized = normalize(path);
      return process.platform === "win32" ? normalized.toLowerCase() : normalized;
    };
    return canonical(paths[0]) === canonical(paths[1]);
  } catch { return false; }
}
