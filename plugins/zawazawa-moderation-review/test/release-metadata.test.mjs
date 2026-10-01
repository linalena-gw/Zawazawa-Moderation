import assert from "node:assert/strict";
import test from "node:test";
import { verifyReleaseMetadata } from "../scripts/verify-release.mjs";

test("公開版の名前とversionは全マニフェストで一致する", () => {
  assert.deepEqual(verifyReleaseMetadata(), {
    pluginName: "zawazawa-moderation-review",
    version: "0.2.0",
    marketplace: "zawazawa-moderation",
  });
});
