import assert from "node:assert/strict";
import test from "node:test";
import {
  AUTHORIZING_DECISION_CHOICES,
  REVIEW_DECISION_CHOICES,
  applyExpiration,
  blockedDependencyGroupsFor,
  deriveAuthorization,
  expiryOf,
  isAuthorizingChoice,
  isDecisionChoice,
  isExecutableItem,
  isExpired,
} from "../server/review-authorization.mjs";
import { executionStatusForEffect } from "../server/admin-writer.mjs";

const items = [
  { id: "96000", dependencyGroup: "tree-1" },
  { id: "96001", dependencyGroup: "tree-1" },
  { id: "96002" },
];

test("承認と代替案だけが実行許可を作り、保留と未回答は作らない", () => {
  assert.deepEqual(REVIEW_DECISION_CHOICES, ["approve", "hold", "alternative"]);
  assert.deepEqual(AUTHORIZING_DECISION_CHOICES, ["approve", "alternative"]);
  assert.equal(isDecisionChoice("approve"), true);
  assert.equal(isDecisionChoice("undecided"), false);
  assert.equal(isAuthorizingChoice("approve"), true);
  assert.equal(isAuthorizingChoice("alternative"), true);
  assert.equal(isAuthorizingChoice("hold"), false);
  assert.equal(isAuthorizingChoice("undecided"), false);
});

test("判断から実行許可と実行候補を導く", () => {
  const derived = deriveAuthorization(items, [
    { itemId: "96000", choice: "approve" },
    { itemId: "96001", choice: "alternative" },
    { itemId: "96002", choice: "hold" },
  ]);
  assert.deepEqual(derived.approvedItemIds, ["96000"]);
  assert.deepEqual(derived.alternativeItemIds, ["96001"]);
  assert.deepEqual(derived.heldItemIds, ["96002"]);
  assert.deepEqual(derived.authorizedItemIds, ["96000", "96001"]);
  assert.deepEqual(derived.blockedDependencyGroups, []);
  assert.deepEqual(derived.executableAuthorizedItemIds, ["96000", "96001"]);
  assert.deepEqual(derived.executableApprovedItemIds, ["96000"]);
  assert.deepEqual(derived.executableAlternativeItemIds, ["96001"]);
});

test("依存グループ内に実行許可と保留・未回答が混在するとグループ全体を止める", () => {
  const held = deriveAuthorization(items, [
    { itemId: "96000", choice: "approve" },
    { itemId: "96001", choice: "hold" },
    { itemId: "96002", choice: "approve" },
  ]);
  assert.deepEqual(held.blockedDependencyGroups.map((group) => group.group), ["tree-1"]);
  assert.deepEqual(held.blockedDependencyGroups[0].itemIds, ["96000", "96001"]);
  assert.deepEqual(held.authorizedItemIds, ["96000", "96002"]);
  // 依存しない単位は続行してよい。
  assert.deepEqual(held.executableAuthorizedItemIds, ["96002"]);
  assert.deepEqual(held.executableApprovedItemIds, ["96002"]);

  // 未回答も実行許可ではないため、同じ理由でグループ全体を止める。
  const undecided = blockedDependencyGroupsFor(items, [
    { itemId: "96000", choice: "approve" },
  ]);
  assert.deepEqual(undecided[0].choices, [
    { itemId: "96000", choice: "approve" },
    { itemId: "96001", choice: "undecided" },
  ]);

  // グループ全体に実行許可がある場合は止めない。
  assert.deepEqual(
    blockedDependencyGroupsFor(items, [
      { itemId: "96000", choice: "approve" },
      { itemId: "96001", choice: "alternative" },
    ]),
    [],
  );
  // グループ全体が保留の場合も、止める対象にはならない。
  assert.deepEqual(
    blockedDependencyGroupsFor(items, [
      { itemId: "96000", choice: "hold" },
      { itemId: "96001", choice: "hold" },
    ]),
    [],
  );
});

test("期限は記録した値だけを採用し、読み取れない記録を期限切れへ倒す", () => {
  const now = Date.parse("2026-08-26T00:00:00.000Z");
  assert.equal(expiryOf({ expiresAt: "2026-08-27T00:00:00.000Z" }), Date.parse("2026-08-27T00:00:00.000Z"));
  assert.ok(Number.isNaN(expiryOf({ expiresAt: "壊れた日時" })));
  assert.ok(Number.isNaN(expiryOf(undefined)));
  assert.equal(isExpired({ expiresAt: "2026-08-27T00:00:00.000Z" }, now), false);
  assert.equal(isExpired({ expiresAt: "2026-08-25T00:00:00.000Z" }, now), true);
  assert.equal(isExpired({}, now), true);
  assert.equal(isExpired({ expiresAt: "壊れた日時" }, now), true);
});

test("期限切れは実行候補だけを空にし、承認した内容の記録は残す", () => {
  const submission = {
    authorizedItemIds: ["96000"],
    approvedItemIds: ["96000"],
    executableApprovedItemIds: ["96000"],
    executableAlternativeItemIds: [],
    executableAuthorizedItemIds: ["96000"],
  };
  assert.equal(applyExpiration(submission, false), submission);
  const expired = applyExpiration(submission, true);
  assert.deepEqual(expired.executableAuthorizedItemIds, []);
  assert.deepEqual(expired.executableApprovedItemIds, []);
  assert.deepEqual(expired.authorizedItemIds, ["96000"]);
  assert.match(expired.executionBlockedReason, /有効期限を過ぎています/u);
  assert.equal(applyExpiration(null, true), null);
});

test("実行可否は期限・送信の有無・依存グループ停止をまとめて判定する", () => {
  const submission = { executableAuthorizedItemIds: ["96000"] };
  assert.equal(isExecutableItem({ submission, expired: false, itemId: "96000" }), true);
  assert.equal(isExecutableItem({ submission, expired: true, itemId: "96000" }), false);
  assert.equal(isExecutableItem({ submission, expired: false, itemId: "96001" }), false);
  assert.equal(isExecutableItem({ submission: null, expired: false, itemId: "96000" }), false);
});

test("送信結果の観測を実行状態へ写す", () => {
  // 外部送信を開始した後は、効果を確認できた場合だけconfirmedにする。
  assert.equal(executionStatusForEffect(true), "confirmed");
  // 効果が生じていないという観測も、同じ承認での自動再送を許す根拠にしない。
  assert.equal(executionStatusForEffect(false), "unknown");
  assert.equal(executionStatusForEffect(undefined), "unknown");
  assert.equal(executionStatusForEffect(null), "unknown");
});
