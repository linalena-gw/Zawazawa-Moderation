import { homedir, platform as hostPlatform } from "node:os";
import { isAbsolute, join, win32 } from "node:path";

function isFullyQualifiedWindowsPath(value) {
  if (!win32.isAbsolute(value)) return false;
  const { root } = win32.parse(value);
  return root !== "\\" && root !== "/";
}

function windowsLocalAppData(env) {
  const directory = env.LOCALAPPDATA;
  if (
    typeof directory !== "string" ||
    !directory.trim() ||
    !isFullyQualifiedWindowsPath(directory)
  ) {
    throw new Error(
      "WindowsのLOCALAPPDATAから安全な保存先を特定できません。環境を修復するか、対象のZAWAZAWA_*_DIRを絶対パスで指定してください。",
    );
  }
  return directory;
}

function unsupportedPlatform(platform) {
  throw new Error(
    `このOS（${platform}）の既定保存先は正式対応外です。対象のZAWAZAWA_*_DIRを絶対パスで指定してください。`,
  );
}

function explicitDirectory(env, name, platform) {
  const value = env[name];
  if (value === undefined) return null;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name}は絶対パスで指定してください。`);
  }
  const absolute = platform === "win32" ? isFullyQualifiedWindowsPath(value) : isAbsolute(value);
  if (!absolute) throw new Error(`${name}は絶対パスで指定してください。`);
  return value;
}

export function defaultReviewStoreDirectory({
  env = process.env,
  platform = hostPlatform(),
  home = homedir(),
} = {}) {
  const explicit = explicitDirectory(env, "ZAWAZAWA_REVIEW_STORE_DIR", platform);
  if (explicit) return explicit;
  if (platform === "darwin") {
    return join(home, "Library", "Application Support", "ZAWAZAWA Moderation Review", "reviews");
  }
  if (platform === "win32") {
    return win32.join(windowsLocalAppData(env), "ZAWAZAWA Moderation Review", "reviews");
  }
  return unsupportedPlatform(platform);
}

export function defaultConnectorProfileDirectory({
  env = process.env,
  platform = hostPlatform(),
  home = homedir(),
} = {}) {
  const explicit = explicitDirectory(env, "ZAWAZAWA_CONNECTOR_PROFILE_DIR", platform);
  if (explicit) return explicit;
  if (platform === "darwin") {
    // 既存利用者の認証済みプロファイルを失わないため、旧名を維持する。
    return join(
      home,
      "Library",
      "Application Support",
      "Codex",
      "ZAWAZAWA Moderation Connector",
      "chrome-profile",
    );
  }
  if (platform === "win32") {
    return win32.join(
      windowsLocalAppData(env),
      "ZAWAZAWA Moderation Review",
      "connector-profile",
    );
  }
  return unsupportedPlatform(platform);
}
