import assert from "node:assert/strict";
import { join, win32 } from "node:path";
import test from "node:test";
import {
  defaultBrowsersDirectory,
  defaultConnectorProfileDirectory,
  defaultPluginHomeDirectory,
  defaultReviewStoreDirectory,
  defaultRuntimeDirectory,
} from "../server/platform-paths.mjs";

test("macOSは既存のレビュー保存先と認証プロファイルを維持する", () => {
  const home = "/Users/example";
  assert.equal(
    defaultReviewStoreDirectory({ platform: "darwin", home, env: {} }),
    join(home, "Library", "Application Support", "ZAWAZAWA Moderation Review", "reviews"),
  );
  assert.equal(
    defaultConnectorProfileDirectory({ platform: "darwin", home, env: {} }),
    join(
      home,
      "Library",
      "Application Support",
      "Codex",
      "ZAWAZAWA Moderation Connector",
      "chrome-profile",
    ),
  );
});

test("runtime defaults stay outside the plugin cache on supported platforms", () => {
  assert.equal(defaultRuntimeDirectory({ platform: "darwin", home: "/Users/example", env: {} }),
    join("/Users/example", "Library", "Application Support", "ZAWAZAWA Moderation Review", "runtimes"));
  assert.equal(defaultRuntimeDirectory({ platform: "win32", env: { LOCALAPPDATA: "C:\\Local" } }),
    win32.join("C:\\Local", "ZAWAZAWA Moderation Review", "runtimes"));
});

test("plugin home and shared browser cache use one dedicated base", () => {
  const home = "/Users/example";
  const appSupport = join(home, "Library", "Application Support", "ZAWAZAWA Moderation Review");
  assert.equal(defaultPluginHomeDirectory({ platform: "darwin", home, env: {} }), appSupport);
  assert.equal(defaultBrowsersDirectory({ platform: "darwin", home, env: {} }), join(appSupport, "browsers"));
  assert.equal(defaultRuntimeDirectory({ platform: "darwin", home, env: {} }), join(appSupport, "runtimes"));
  assert.equal(
    defaultPluginHomeDirectory({ platform: "darwin", home, env: { ZAWAZAWA_HOME_DIR: "/custom/zawazawa" } }),
    "/custom/zawazawa",
  );
  assert.equal(
    defaultBrowsersDirectory({ platform: "darwin", home, env: { ZAWAZAWA_HOME_DIR: "/custom/zawazawa" } }),
    join("/custom/zawazawa", "browsers"),
  );
});

test("Windows plugin home and browser cache require a local drive", () => {
  const env = { LOCALAPPDATA: "D:\\Users\\example\\AppData\\Local" };
  const base = win32.join(env.LOCALAPPDATA, "ZAWAZAWA Moderation Review");
  assert.equal(defaultPluginHomeDirectory({ platform: "win32", env }), base);
  assert.equal(defaultBrowsersDirectory({ platform: "win32", env }), win32.join(base, "browsers"));
  assert.equal(
    defaultBrowsersDirectory({ platform: "win32", env: { PLAYWRIGHT_BROWSERS_PATH: "E:\\Playwright\\browsers" } }),
    "E:\\Playwright\\browsers",
  );
  assert.throws(
    () => defaultPluginHomeDirectory({ platform: "win32", env: { ZAWAZAWA_HOME_DIR: "\\\\example\\share\\base" } }),
    /ローカルドライブ/u,
  );
  assert.throws(
    () => defaultBrowsersDirectory({ platform: "win32", env: { PLAYWRIGHT_BROWSERS_PATH: "\\\\example\\share\\browsers" } }),
    /ローカルドライブ/u,
  );
});

test("Windows runtime rejects UNC overrides while operational directories accept them", () => {
  const unc = "\\\\example\\share\\runtime";
  assert.throws(() => defaultRuntimeDirectory({ platform: "win32", env: { ZAWAZAWA_RUNTIME_DIR: unc } }), /ローカルドライブ/u);
  assert.throws(() => defaultRuntimeDirectory({ platform: "win32", env: { LOCALAPPDATA: unc } }), /ローカルドライブ/u);
  assert.equal(defaultReviewStoreDirectory({ platform: "win32", env: { ZAWAZAWA_REVIEW_STORE_DIR: unc } }), unc);
  assert.equal(defaultRuntimeDirectory({ platform: "win32", env: { ZAWAZAWA_RUNTIME_DIR: "D:\\runtime" } }), "D:\\runtime");
  assert.throws(() => defaultRuntimeDirectory({ platform: "linux", env: { ZAWAZAWA_RUNTIME_DIR: "relative" } }), /絶対パス/u);
});

test("WindowsはLOCALAPPDATA配下のベンダー中立な保存先を使う", () => {
  const env = { LOCALAPPDATA: "C:\\Users\\example\\AppData\\Local" };
  assert.equal(
    defaultReviewStoreDirectory({ platform: "win32", env }),
    win32.join(env.LOCALAPPDATA, "ZAWAZAWA Moderation Review", "reviews"),
  );
  assert.equal(
    defaultConnectorProfileDirectory({ platform: "win32", env }),
    win32.join(env.LOCALAPPDATA, "ZAWAZAWA Moderation Review", "connector-profile"),
  );
});

test("Windowsの保存先を安全に解決できない場合は停止する", () => {
  for (const env of [
    {},
    { LOCALAPPDATA: "" },
    { LOCALAPPDATA: "relative" },
    { LOCALAPPDATA: "\\AppData\\Local" },
    { LOCALAPPDATA: "/AppData/Local" },
  ]) {
    assert.throws(
      () => defaultReviewStoreDirectory({ platform: "win32", env }),
      /LOCALAPPDATA/u,
    );
    assert.throws(
      () => defaultConnectorProfileDirectory({ platform: "win32", env }),
      /LOCALAPPDATA/u,
    );
  }
});

test("明示した保存先はOSにかかわらず優先する", () => {
  assert.equal(
    defaultReviewStoreDirectory({
      platform: "linux",
      env: { ZAWAZAWA_REVIEW_STORE_DIR: "/explicit/reviews" },
    }),
    "/explicit/reviews",
  );
  assert.equal(
    defaultConnectorProfileDirectory({
      platform: "linux",
      env: { ZAWAZAWA_CONNECTOR_PROFILE_DIR: "/explicit/profile" },
    }),
    "/explicit/profile",
  );
});

test("明示した保存先も相対パスなら拒否する", () => {
  assert.throws(
    () =>
      defaultReviewStoreDirectory({
        platform: "linux",
        env: { ZAWAZAWA_REVIEW_STORE_DIR: "relative/reviews" },
      }),
    /絶対パス/u,
  );
  assert.throws(
    () =>
      defaultConnectorProfileDirectory({
        platform: "win32",
        env: { ZAWAZAWA_CONNECTOR_PROFILE_DIR: "relative\\profile" },
      }),
    /絶対パス/u,
  );
  assert.throws(
    () =>
      defaultConnectorProfileDirectory({
        platform: "win32",
        env: { ZAWAZAWA_CONNECTOR_PROFILE_DIR: "\\profiles\\zawazawa" },
      }),
    /絶対パス/u,
  );
});

test("未対応OSは明示設定が無ければ既定値を推測しない", () => {
  assert.throws(() => defaultReviewStoreDirectory({ platform: "linux", env: {} }), /正式対応外/u);
  assert.throws(
    () => defaultConnectorProfileDirectory({ platform: "linux", env: {} }),
    /正式対応外/u,
  );
});
