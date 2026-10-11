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

function windowsLocalDirectory(directory, name) {
  if (!/^[a-z]:[\\/]/iu.test(directory)) {
    throw new Error(`${name}はWindowsのローカルドライブの絶対パスで指定してください。`);
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

export function defaultPluginHomeDirectory({
  env = process.env,
  platform = hostPlatform(),
  home = homedir(),
} = {}) {
  const explicit = explicitDirectory(env, "ZAWAZAWA_HOME_DIR", platform);
  if (explicit) {
    if (platform === "win32") windowsLocalDirectory(explicit, "ZAWAZAWA_HOME_DIR");
    return explicit;
  }
  if (platform === "darwin") {
    return join(home, "Library", "Application Support", "ZAWAZAWA Moderation Review");
  }
  if (platform === "win32") {
    return windowsLocalDirectory(
      win32.join(windowsLocalAppData(env), "ZAWAZAWA Moderation Review"),
      "ZAWAZAWA_HOME_DIR",
    );
  }
  return unsupportedPlatform(platform);
}

export function defaultBrowsersDirectory({
  env = process.env,
  platform = hostPlatform(),
  home = homedir(),
} = {}) {
  const explicit = explicitDirectory(env, "PLAYWRIGHT_BROWSERS_PATH", platform);
  const joinForPlatform = platform === "win32" ? win32.join : join;
  const directory = explicit ?? joinForPlatform(defaultPluginHomeDirectory({ env, platform, home }), "browsers");
  if (platform === "win32") windowsLocalDirectory(directory, "PLAYWRIGHT_BROWSERS_PATH");
  return directory;
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

export function defaultRuntimeDirectory({
  env = process.env,
  platform = hostPlatform(),
  home = homedir(),
} = {}) {
  const explicit = explicitDirectory(env, "ZAWAZAWA_RUNTIME_DIR", platform);
  const joinForPlatform = platform === "win32" ? win32.join : join;
  const directory = explicit ?? joinForPlatform(defaultPluginHomeDirectory({ env, platform, home }), "runtimes");
  // Runtime code and native dependencies require a local drive on Windows.
  // Operational document/profile overrides retain their existing UNC support.
  if (platform === "win32") windowsLocalDirectory(directory, "ZAWAZAWA_RUNTIME_DIR");
  return directory;
}
