import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { buildReviewHtml, mcpAppRuntimeScript } from "../server/mcp-app-runtime.mjs";

// ui/review.htmlは単一ファイルでホストへ配るため、判定部分だけを区間コメントで切り出して検証する。
const html = await readFile(new URL("../ui/review.html", import.meta.url), "utf8");
const widgetStateStart = html.indexOf("// [widget-state:start]");
const widgetStateEnd = html.indexOf("// [widget-state:end]");
assert.ok(
  widgetStateStart >= 0 && widgetStateEnd > widgetStateStart,
  "widgetStateSnapshotの抽出区間がui/review.htmlにない",
);
const widgetStateSnapshot = new Function(
  `${html.slice(widgetStateStart, widgetStateEnd)}; return widgetStateSnapshot;`,
)();
const commentRolesStart = html.indexOf("// [comment-roles:start]");
const commentRolesEnd = html.indexOf("// [comment-roles:end]");
assert.ok(
  commentRolesStart >= 0 && commentRolesEnd > commentRolesStart,
  "commentRolesの抽出区間がui/review.htmlにない",
);
const commentRoles = new Function(
  `${html.slice(commentRolesStart, commentRolesEnd)}; return commentRoles;`,
)();
const reportLaneTitleStart = html.indexOf("// [report-lane-title:start]");
const reportLaneTitleEnd = html.indexOf("// [report-lane-title:end]");
assert.ok(
  reportLaneTitleStart >= 0 && reportLaneTitleEnd > reportLaneTitleStart,
  "reportLaneTitleの抽出区間がui/review.htmlにない",
);
const reportLaneTitle = new Function(
  `${html.slice(reportLaneTitleStart, reportLaneTitleEnd)}; return reportLaneTitle;`,
)();
const reportModeStart = html.indexOf("// [report-mode:start]");
const reportModeEnd = html.indexOf("// [report-mode:end]");
assert.ok(
  reportModeStart >= 0 && reportModeEnd > reportModeStart,
  "結果報告の抽出区間がui/review.htmlにない",
);
const reportMode = html.slice(reportModeStart, reportModeEnd);
const reportStatusStart = html.indexOf("// [report-status:start]");
const reportStatusEnd = html.indexOf("// [report-status:end]");
assert.ok(
  reportStatusStart >= 0 && reportStatusEnd > reportStatusStart,
  "reportUnitStatusの抽出区間がui/review.htmlにない",
);
const reportUnitStatus = new Function(
  `${html.slice(reportStatusStart, reportStatusEnd)}; return reportUnitStatus;`,
)();

test("差し込みアンカーが本体スクリプトより前にある", () => {
  // アンカーが消えた一覧HTMLは、ホスト連携のない画面を無言で配ることになる。
  // 実サーバー（ui://・ループバック）とプレビューの3経路が同じ位置に依存する。
  const runtimeAnchor = html.indexOf("<!-- mcp-app-runtime -->");
  const bootstrapAnchor = html.indexOf("<!-- host-bootstrap -->");
  const mainScript = html.indexOf("initializeHost()");
  assert.ok(runtimeAnchor >= 0, "<!-- mcp-app-runtime -->がui/review.htmlにない");
  assert.ok(bootstrapAnchor >= 0, "<!-- host-bootstrap -->がui/review.htmlにない");
  assert.ok(runtimeAnchor < mainScript && bootstrapAnchor < mainScript);
  assert.equal(html.indexOf("<!-- host-bootstrap -->", bootstrapAnchor + 1), -1);
});

test("一覧UIへMCP AppsのApp側SDKを埋め込み、window.McpAppsとして読めるようにする", () => {
  const built = buildReviewHtml(html);
  assert.ok(built.includes("globalThis.McpApps={"), "SDKのグローバル公開が埋め込まれていない");
  assert.match(built, /"App":/u);
  // 元のHTMLより十分大きい＝SDK本体が入っている。
  assert.ok(built.length > html.length + 100_000);
});

test("差し込み位置の無いHTMLは、接続できない一覧を配らずに失敗する", () => {
  assert.throws(() => buildReviewHtml("<html><body></body></html>"), /mcp-app-runtime/u);
});

test("埋め込むSDKはscript要素を閉じる並びを含まない", () => {
  const script = mcpAppRuntimeScript();
  assert.doesNotMatch(script, /<\/script/iu);
  assert.doesNotMatch(script, /<!--/u);
});

test("ホストとのやり取りを自前のJSON-RPCで組み立てない", () => {
  // ハンドシェイクとメッセージ検証はApp側SDKが持つ。自前実装へ戻ると仕様追従が二重になる。
  assert.doesNotMatch(html, /jsonrpc/u);
  assert.doesNotMatch(html, /window\.parent\.postMessage/u);
  assert.match(html, /new App\(\{ name: "zawazawa-moderation-review"/u);
  assert.match(html, /app\.callServerTool\(\{ name, arguments: args \}\)/u);
  assert.match(html, /app\.ontoolresult = /u);
  assert.match(html, /await app\.connect\(\)/u);
});

test("対処案の通知は通知として受け、要求として送られる前提を持たない", () => {
  // 実機（Claudeデスクトップ）のホストはext-appsのPostMessageTransport経由で、
  // ui/notifications/tool-resultをidの無い通知として送る。idつき要求を待ち受けると
  // SDKの分類と二重になるため、受け口はontoolresultだけにする。
  assert.match(html, /app\.ontoolresult = /u);
  assert.doesNotMatch(html, /ui\/notifications\/tool-result"/u);
});

test("対処案が届かないまま待ち続けず、操作できない旨へ落とす", () => {
  assert.match(html, /const TOOL_RESULT_WAIT_MS = \d+;/u);
  assert.match(html, /startToolResultWait\(\);/u);
  assert.match(html, /loadBatchSummary\(summary\) \{\n\s*stopToolResultWait\(\);/u);
  // 案内はfailLoad経由で出す。承認可能な部分画面を残さないため。
  assert.match(html, /failLoad\("ホストから対処案が届きませんでした。/u);
});

test("判断保存後に会話送信APIを呼んで二重の確認を発生させない", () => {
  assert.doesNotMatch(html, /sendFollowUpMessage/u);
  assert.doesNotMatch(html, /app\.sendMessage/u);
  assert.match(html, /これが実行許可です。追加の許可は不要です/u);
  assert.match(html, /元のタスクで「バッチ \$\{state\.batch\.batchId\} の承認済み操作を実行してください」と伝えてください/u);
  assert.match(html, /\$\("#confirm-title"\)\.textContent = "判断を保存しました"/u);
  assert.match(html, /button\.textContent = "送信済み"/u);
});

test("三経路とも保存済みスナップショットとサーバープレビューを同じツール名で取得する", () => {
  assert.match(html, /callTool\("get_moderation_review_snapshot"/u);
  assert.match(html, /callTool\("preview_moderation_decision"/u);
  assert.match(html, /callTool\("submit_moderation_decisions"/u);
  assert.match(html, /loadBatchSummary\(window\.openai\.toolOutput\)/u);
  assert.match(html, /loadBatchSummary\(params\?\.structuredContent\)/u);
});

test("完全スナップショットの取得失敗は承認可能な部分画面へフォールバックしない", () => {
  assert.match(html, /function failLoad\(message\)/u);
  assert.match(html, /部分的な内容では承認できません/u);
  assert.match(html, /cards\.replaceChildren\(\)/u);
  assert.doesNotMatch(html, /summary\?\.items/u);
});

test("widgetStateは構造選択だけを保存し自由文・本文・完全案を残さない", () => {
  const saved = widgetStateSnapshot({
    batchId: "batch-id",
    snapshotToken: "a".repeat(64),
    decisions: {
      "96517": {
        choice: "alternative",
        draft: { supplementalReason: "host: internal.example secret" },
      },
    },
    drafts: {
      "96517": {
        commentActions: { "96517": "delete-1", "96518": "keep" },
        reportOperationId: "complete",
        authorOperationId: "auto-ignore",
        otherOperationIds: ["notice"],
        messageEdits: {
          untouched: { text: "秘密の編集後本文", omit: false },
          dropped: { text: "秘密の編集後本文", omit: true },
        },
        supplementalReason: "port：8443 private",
        resolvedPlan: { messages: [{ text: "保存してはいけない本文" }] },
        resolvedPlanToken: "b".repeat(64),
      },
    },
    submitted: false,
    filter: "all",
  });

  // 承認の中身は行の選択から決まるため、保存する判断は承認と保留だけとする。
  assert.deepEqual(saved.decisions, { "96517": { choice: "approve" } });
  assert.deepEqual(saved.drafts, {
    "96517": {
      commentActions: { "96517": "delete-1", "96518": "keep" },
      reportOperationId: "complete",
      authorOperationId: "auto-ignore",
      otherOperationIds: ["notice"],
      // 送信しない指定だけを残し、編集後の本文はホスト保存へ出さない。
      messageEdits: { dropped: { omit: true } },
    },
  });
  assert.doesNotMatch(
    JSON.stringify(saved),
    /internal\.example|8443|秘密|保存してはいけない|resolvedPlan|supplementalReason/u,
  );
});

test("推奨案もサーバー解決済み完全案とtokenを使って送信する", () => {
  assert.match(html, /resolvedPlanToken: item\.recommendedResolvedPlanToken/u);
  assert.match(html, /candidate\.operationTypeLabel/u);
  // 送信本文は操作へ束縛されたものだけを、その操作の行に出す。
  assert.match(html, /messagesByOperationId\.get\(draft\.reportOperationId\)/u);
});

test("コメントの役割は解決済みの通報記録と処置対象候補から決める", () => {
  const roles = commentRoles({
    reports: [{ reportId: "29500", targetCommentNumber: "96517" }],
    recommendation: {
      targets: [{ commentNumber: "96517" }, { commentNumber: "96518" }],
    },
  });

  assert.equal(roles.get("96517"), "通報対象");
  // 通報されていない処置対象＝親や通報対象の削除にあわせて消す関連コメント。
  assert.equal(roles.get("96518"), "文脈整理対象");
  // 処置対象でも通報対象でもない前後文脈には役割を付けない。
  assert.equal(roles.get("96516"), undefined);
});

test("役割は通報記録と対象候補の対応だけで入れ替わる", () => {
  const roles = commentRoles({
    reports: [{ reportId: "29500", targetCommentNumber: "96518" }],
    recommendation: {
      targets: [{ commentNumber: "96517" }, { commentNumber: "96518" }],
    },
  });

  assert.equal(roles.get("96517"), "文脈整理対象");
  assert.equal(roles.get("96518"), "通報対象");
});

test("対象候補が一つだけの単位では対象番号の無い通報もその対象の通報として扱う", () => {
  const roles = commentRoles({
    reports: [{ reportId: "29500" }],
    recommendation: { targets: [{ commentNumber: "96517" }] },
  });

  assert.equal(roles.get("96517"), "通報対象");
});

test("対象候補が複数ある単位では対象番号の無い通報でどれかを通報対象にしない", () => {
  const roles = commentRoles({
    reports: [{ reportId: "29500" }],
    recommendation: {
      targets: [{ commentNumber: "96517" }, { commentNumber: "96518" }],
    },
  });

  assert.equal(roles.get("96517"), "文脈整理対象");
  assert.equal(roles.get("96518"), "文脈整理対象");
});

test("読み切れた通報表の見出しは読めた件数をそのまま出す", () => {
  assert.equal(reportLaneTitle({ reportCount: 3, reportsTruncated: false }), "通報 3件");
  assert.equal(reportLaneTitle({ reportCount: 0 }), "通報 0件");
});

test("読み切れていない通報表の見出しは、読めた件数を全部として出さない", () => {
  // 管理画面の件数表示から総件数が分かる場合は、総件数と読めた件数の両方を出す。
  assert.equal(
    reportLaneTitle({ reportCount: 20, reportsTruncated: true, reportTotalCount: 25 }),
    "通報 25件（うち20件を表示）",
  );
  // 総件数が分からない場合も、読めた件数だけを件数として出さない。残件数は推測しない。
  assert.equal(
    reportLaneTitle({ reportCount: 20, reportsTruncated: true }),
    "通報 20件以上（全件を読めていません）",
  );
});

test("通報レーンの見出しは、判断前と結果報告の両方で同じ規則から作る", () => {
  // 結果報告だけが読めた件数を全部として出すと、同じ一覧の中で件数の意味が変わる。
  assert.equal(
    html.split('element("h3", { className: "lane-title", text: reportLaneTitle(item) })').length - 1,
    2,
  );
  assert.doesNotMatch(html, /lane-title", text: `通報 \$\{item\.reportCount\}件`/u);
});

test("一覧は役割で色分けし、役割はコメントの列にだけ出す", () => {
  assert.match(html, /const roles = commentRoles\(item\);/u);
  assert.match(html, /"data-role": role/u);
  assert.match(html, /\.comment-item\[data-role="文脈整理対象"\]/u);
  // 役割の付かない行のラベルも解決結果から導く。モデルが書いた語は入り込まない。
  assert.match(html, /roles\.get\(comment\.commentNumber\) \|\| "前後文脈",/u);
  assert.doesNotMatch(html, /comment\.relationship/u);
  // 対処案の列へ役割を再掲しない。同じ語が二列に出ると、どちらが判断材料か決められない。
  assert.match(html, /function commentActionCell\(item, draft, plan, comment\) \{/u);
  assert.doesNotMatch(html, /commentActionCell\(item, draft, plan, [^)]*, /u);
});

test("現在状態か管理画面を解決できない行は処置対象として選ばせない", () => {
  // サーバーのselectableTargetsForと同じ条件で行を落とす。片方だけを緩めると、
  // 承認できてしまう行と実行時に破損として止まる行が食い違う。
  assert.match(html, /return isTarget \|\| Boolean\(comment\.currentState && comment\.url\);/u);
  assert.match(html, /if \(!isSelectableRow\(item, comment\)\) return \[\];/u);
  assert.match(html, /現在状態を確認できないため、この行は処置対象に選べません。/u);
});

test("投稿規制と通報の扱いは、効く対象を選び直すたびに注記へ出す", () => {
  // 投稿者・接続元への措置はanchorコメントの投稿者へ効く。どの投稿者かを画面で示す。
  assert.match(html, /対象 \$\{targets\} の投稿者。/u);
  // 選択を変えてもカードは組み直されないため、注記は選択のたびに更新する。
  assert.match(html, /renderNote\(\);\n\s+onDraftChanged\(item\);/u);
  assert.match(html, /対象 \$\{targets\} の通報を閉じます。/u);
});

test("判断カードの適用基準は展開内に見出しを繰り返さない", () => {
  const card = html.slice(html.indexOf("function createCard("), html.indexOf("function link("));
  assert.equal([...card.matchAll(/適用した基準/gu)].length, 1);
  assert.match(card, /element\("ul", \{\}, \(item\.basis \|\| \[\]\)\.map/u);
  assert.doesNotMatch(card, /listBlock\(/u);
});

test("restricted送信欄は状態別件数を繰り返さず、送信確認の内訳は保つ", () => {
  const progressStart = html.indexOf("function updateProgress()");
  const progressEnd = html.indexOf("// [widget-state:start]", progressStart);
  const progress = html.slice(progressStart, progressEnd);
  assert.match(progress, /`\$\{value\.decided\} \/ \$\{value\.total\}件を選択`/u);
  assert.match(progress, /\$\("#count-approve"\)\.textContent = `承認 \$\{value\.approve\}`/u);
  assert.match(progress, /\$\("#count-hold"\)\.textContent = `保留 \$\{value\.hold\}`/u);
  assert.match(progress, /\$\("#count-alternative"\)\.textContent = `変更して承認 \$\{value\.alternative\}`/u);
  const footerGuidance = progress.slice(
    progress.indexOf("const unselectedGuidance"),
    progress.indexOf("submit.textContent"),
  );
  assert.match(footerGuidance, /const unselectedGuidance = `未選択 \$\{value\.undecided\}件は実行されません。`/u);
  assert.doesNotMatch(footerGuidance, /推奨どおり承認 \$\{value\.approve\}/u);
  assert.doesNotMatch(footerGuidance, /変更して承認 \$\{value\.alternative\}/u);
  assert.doesNotMatch(footerGuidance, /保留 \$\{value\.hold\}/u);
  assert.match(html, /#confirm-summary.*推奨どおり承認 \$\{value\.approve\}件、変更して承認 \$\{value\.alternative\}件、保留 \$\{value\.hold\}件/u);
});

test("UIに投稿ごとの承認・保留と最終送信を備える", () => {
  // 判断は承認と保留の二択とし、承認の中身は行の選択が推奨案と同じかどうかで決まる。
  assert.match(html, /choiceButton\(item\.id, "approve", "承認"\)/u);
  assert.match(html, /choiceButton\(item\.id, "hold", "保留"\)/u);
  assert.match(html, /function isChangedDraft\(item, draft\)/u);
  // 判断は通報の扱いと同じ場所で選ぶ。判断だけの別ブロックを置かない。
  assert.match(html, /text: "この投稿の判断"/u);
  assert.doesNotMatch(html, /className: "decision"/u);
  // 実行内容の自然言語での再掲は置かず、行の選択そのものを承認内容の表示とする。
  assert.doesNotMatch(html, /outcome-list/u);
  assert.doesNotMatch(html, /supplementalReason/u);
  assert.match(html, /get_moderation_review_snapshot/u);
  assert.match(html, /preview_moderation_decision/u);
  assert.match(html, /この選択を送信/u);
  assert.match(html, /submit_moderation_decisions/u);
  assert.match(html, /確認した過去投稿/u);
  assert.match(html, /適用した基準/u);
  assert.doesNotMatch(html, /実施しない高影響措置/u);
  assert.doesNotMatch(html, /過剰対応リスク/u);
  assert.doesNotMatch(html, /不確実性/u);
  assert.doesNotMatch(html, /留意点/u);
});

test("一覧は判断に使う内容だけを出し、承認境界の内部識別子を画面へ書かない", () => {
  // 通報理由は本文のまま出し、投稿履歴は件数だけを出して畳む。
  assert.match(html, /className: "report-reason"/u);
  assert.match(html, /確認した過去投稿（\$\{history\.length\}件）/u);
  assert.doesNotMatch(html, /reportId/u);
  assert.doesNotMatch(html, /原子ステップ/u);
  assert.doesNotMatch(html, /編集されない承認境界/u);
  assert.doesNotMatch(html, /完全案の送信本文一覧/u);
  assert.doesNotMatch(html, /一覧スナップショット全体の通報/u);
  // 操作の内部コードとメッセージIDは実行直前照合のためにサーバーが持ち、画面には出さない。
  assert.doesNotMatch(html, /\$\{messageId\}/u);
  assert.doesNotMatch(html, /operation\.operationType\}（/u);
  // モデルが書いた操作の言い換えは実行内容を変えないため、固定ラベルだけを出す。
  assert.doesNotMatch(html, /candidate\.text/u);
  assert.doesNotMatch(html, /説明: /u);
});

test("案件の見出しは表題だけを出し、推奨の言い換えも内部の関係も載せない", () => {
  // 見出しはサーバーが組み立てた表題（トピック名と処置対象のコメント番号）だけにする。
  assert.match(html, /postLine\.append\(element\("h2", \{ text: item\.title \|\| `投稿 \$\{item\.id\}` \}\)\);/u);
  // 推奨内容を自然文で言い直した判定は、行の選択と同じ内容の二重表示になるので持たない。
  assert.doesNotMatch(html, /verdict/u);
  // 依存グループは実行候補をサーバーが決めるための内部の関係で、判断材料ではない。
  assert.doesNotMatch(html, /item\.dependencyGroup/u);
  assert.doesNotMatch(html, /依存: /u);
});

test("通報は先頭の数件だけを開き、残りは同じ場所へ開くボタンにする", () => {
  // 多量の通報で一覧が縦に伸びると、他の処理単位へ辿り着けなくなる。
  assert.match(html, /const VISIBLE_REPORT_COUNT = 3;/u);
  assert.match(html, /if \(index >= VISIBLE_REPORT_COUNT\)/u);
  assert.match(html, /text: `もっと見る（残り\$\{hidden\.length\}件）`/u);
  // 隠した通報が場所を取らないようにする。
  assert.match(html, /\.report-item\[hidden\] \{ display: none; \}/u);
  // 開いたあとは畳まない。判断の途中で読んだ通報が画面から消えないようにする。
  assert.match(html, /more\.remove\(\);/u);
  assert.doesNotMatch(html, /折りたたむ|閉じる（残り/u);
  // 続きを開くのは表示操作なので、判断を送信したあとも押せるままにする。
  assert.match(html, /"button:not\(\.more-reports\), input, select, textarea"/u);
});

test("代替案は順序を管理者へ委ねず、提案本文をその場で編集させる", () => {
  // 実行順はサーバーが候補の宣言順で決めるため、並べ替えの操作を置かない。
  assert.doesNotMatch(html, /order-buttons/u);
  assert.doesNotMatch(html, /一つ前へ/u);
  assert.doesNotMatch(html, /orderedOperationIds/u);
  assert.match(html, /selectedOperationIds/u);
  // 提案本文は束縛先の操作の隣で直接編集し、扱いをプルダウンで選ばせない。
  assert.match(html, /className: "row-message"/u);
  assert.match(html, /text: "送信しない"/u);
  assert.doesNotMatch(html, /扱いを選択/u);
  assert.doesNotMatch(html, /表示済みメッセージの扱い/u);
});

test("対処案はコメント行と通報欄の隣で選び、別ブロックへ切り出さない", () => {
  // 判断材料の各行と対処案を同じ行へ並べる。番号を探して往復させない。
  assert.match(html, /className: "lane-title", text: "対処案"/u);
  assert.match(html, /className: "lane-title", text: "通報の扱いと判断"/u);
  assert.match(html, /className: "lane-title", text: "投稿規制"/u);
  assert.match(html, /commentLane\(item, draft, plan, roles\)/u);
  assert.match(html, /reportLane\(item, draft, plan\)/u);
  assert.match(html, /historyLane\(item, draft, plan\)/u);
  // コメントは削除と保持、通報は完了と無視をその行で選ぶ。
  assert.match(html, /label: "保持"/u);
  assert.match(html, /"report_complete" \? "完了" : "無視"/u);
  assert.match(html, /label: "保留", kind: ""/u);
  assert.match(html, /"author_auto_ignore" \? "自動無視" : "ブロック"/u);
  assert.match(html, /label: "なし"/u);
  // 操作の選択を別立てするチェックボックス群は、単位全体へ効く操作にだけ残す。
  assert.doesNotMatch(html, /text: "実行する操作"/u);
  assert.doesNotMatch(html, /実際に処置する対象/u);
  assert.match(html, /text: "この投稿への追加操作"/u);
});

test("選択が推奨案と変わったときだけ、変更内容をサーバーで解決し直す", () => {
  assert.match(html, /function onDraftChanged\(item\)/u);
  assert.match(html, /draft\.resolvedPlanToken = null;/u);
  // 解決中に選択が動いた場合、その結果を今の承認内容として使わない。
  assert.match(html, /JSON\.stringify\(structuredChanges\(item, draft\)\) !== JSON\.stringify\(changes\)/u);
  // 操作ごとの対象絞り込みで、保持したコメントを削除操作から外す。
  assert.match(html, /operationTargets/u);
});

test("UIヘッダーは最終確認日時だけを表示する", () => {
  assert.match(html, /<time id="checked-at">—<\/time>/u);
  assert.match(html, /formatCheckedAt\(batch\.createdAt\)/u);
  assert.doesNotMatch(html, /class="count-badge"/u);
  assert.doesNotMatch(html, /id="item-count"/u);
  assert.doesNotMatch(html, /各投稿の完全な推奨案を確認/u);
  assert.doesNotMatch(html, /この画面だけでは外部操作を行いません/u);
});

test("結果報告は同じ一覧から編集機能を落として描画する", () => {
  // ホストもサーバーも持たないファイルとして開くので、報告の経路は呼び出しを行わない。
  assert.doesNotMatch(reportMode, /callTool|window\.openai|app\.call/u);
  // 判断を入力する要素は描画そのものを行わず、既にある要素は取り除く。
  assert.doesNotMatch(reportMode, /actionSelect|messageEditor|choiceButton|element\("(select|textarea|input|button)"/u);
  assert.match(reportMode, /\.submit-dock"\)\?\.remove\(\)/u);
  assert.match(reportMode, /#confirm-dialog"\)\?\.remove\(\)/u);
  // 実行状態は記録どおりに出し、記録の無い操作を実行済みへ寄せない。
  assert.match(reportMode, /text: "未実行"|\|\| "未実行"/u);
  assert.match(reportMode, /journalMismatch/u);
  // 判断材料の描画は対話用の一覧と同じ組み立てを使う。
  assert.match(reportMode, /commentBlock\(/u);
  assert.match(reportMode, /reportListBlock\(item\)/u);
  assert.match(reportMode, /historyDetails\(item\)/u);
  // 報告として開いたときだけ描画し、対話用の初期化とは排他にする。
  assert.match(html, /window\.__zawazawaReport\) \{\n\s+renderReport\(window\.__zawazawaReport\);/u);
});

test("単位の見出しは実行ジャーナルの状態を実際より良くも悪くも見せない", () => {
  const unit = (choice, statuses) => ({
    choice,
    steps: statuses.map((status) =>
      status === "mismatch"
        ? { status: null, journalMismatch: true }
        : { status, journalMismatch: false },
    ),
  });

  // 記録の無い操作と結果の分からない操作を実行済みへ寄せない。
  assert.equal(reportUnitStatus(unit("approve", ["confirmed"])).label, "実行済み");
  assert.equal(reportUnitStatus(unit("approve", [null])).label, "未実行");
  assert.equal(reportUnitStatus(unit("approve", ["ready"])).label, "未実行");
  assert.equal(reportUnitStatus(unit("approve", ["dispatching"])).label, "結果不明");
  assert.equal(reportUnitStatus(unit("approve", ["confirmed", "unknown"])).label, "結果不明");
  assert.equal(reportUnitStatus(unit("approve", ["mismatch"])).label, "記録の不一致");
  // 一部だけ実行できた単位を未実行と書くと、確認済みの操作がやり直しの対象に見える。
  assert.equal(reportUnitStatus(unit("approve", ["confirmed", null])).label, "一部実行");

  // 代替案の承認も実行許可を作る。実行済みの単位を判断なしとして落とさない。
  assert.equal(reportUnitStatus(unit("alternative", ["confirmed"])).label, "実行済み");
  assert.equal(reportUnitStatus(unit("alternative", [null])).label, "未実行");

  // 実行許可を作らない判断は、実行状態にかかわらずそのまま出す。
  assert.equal(reportUnitStatus(unit("hold", [])).label, "保留");
  assert.equal(reportUnitStatus(unit("undecided", [])).label, "判断なし");
});
