import { appendFileSync, existsSync } from "node:fs";
import { ZawazawaConnectorError } from "../server/identifiers.mjs";

/**
 * 送信経路の分岐を対象コメント番号で選ぶ。実サイトへ出ないまま、確認できた成功、
 * 効果の不在を確認できた失敗、送信前の失敗、結果不明を一つのサーバープロセスで試す。
 */
const EXECUTION_BEHAVIOR = {
  96550: {
    precheck: { openReportIds: ["r-a", "r-b", "r-c", "r-new"] },
    effect: (ids) => ids.length === 1 && ids[0] === "r-a",
  },
  96551: {
    precheck: { openReportIds: ["r-b", "r-c", "r-new"], closedReportIds: ["r-a"] },
    effect: true,
  },
  96517: { effect: true },
  // 効果の不在を読めても、送信を開始した以上は結果不明へ倒す。
  96518: { effect: false },
  96519: { prepareErrorCode: "blocked" },
  96541: { prepareErrorCode: "rate_limited" },
  96542: { prepareErrorCode: "profile_locked" },
  96543: { prepareErrorCode: "not_found" },
  96521: { effect: undefined, readback: undefined },
  // 実行直前照合で止まる分岐。送信されないことを確かめるため、`submit`は必ず失敗する。
  96523: {
    submitMustNotHappen: true,
    precheck: { openReportIds: [], reportsUnavailable: true },
  },
  // 承認済み通報が未処理にも処理済みにも無い。閉じた先を追えないので止まる。
  96524: {
    submitMustNotHappen: true,
    precheck: { openReportIds: ["connector-report-other"] },
  },
  // 通報表を読み切れていない完了。読めなかった通報も、送信までに届いた通報も、
  // 同じ承認済み本文で続けて閉じる。
  96531: (() => {
    let remaining = ["connector-report-late"];
    let prepares = 0;
    return {
      effect: true,
      readback: true,
      precheck: () => {
        prepares += 1;
        // 1回目は読み切れていない通報表、2回目は残った未処理通報だけが見える。
        return prepares === 1
          ? { openReportIds: ["connector-report-96531"], openReportsTruncated: true }
          : { openReportIds: [...remaining] };
      },
      // 承認済み通報を閉じた後も残りが見え、その残りを閉じる送信で無くなる。
      afterSubmit: (reportIds) => {
        if (reportIds.includes("connector-report-late")) remaining = [];
        return [...remaining];
      },
      remainingOpenReportIds: () => [...remaining],
      expectSubmission: ({ reportIds }) =>
        reportIds.length === 1 &&
        (reportIds[0] === "connector-report-96531" || reportIds[0] === "connector-report-late"),
    };
  })(),
  // 送信しても効果が出なかった完了。承認済み操作の送信先だった通報が未処理のまま
  // 見えても、同じ承認では送り直さない。二度目の送信が届いた場合だけ残件が増えるので、
  // 自動再送は結果から見分けられる。
  96532: (() => {
    let submits = 0;
    const remaining = () =>
      submits > 1
        ? ["connector-report-96532", "connector-report-resent"]
        : ["connector-report-96532"];
    return {
      effect: false,
      readback: false,
      afterSubmit: () => {
        submits += 1;
        return remaining();
      },
      remainingOpenReportIds: remaining,
    };
  })(),
  // 追加の完了を送っても効果を確認できない場合。閉じた件数として数えず残件として返す。
  96533: (() => {
    let prepares = 0;
    return {
      // 承認済み通報の完了は確認できるが、追加分の完了は確認できない。
      effect: (reportIds) => (reportIds.includes("connector-report-96533") ? true : undefined),
      readback: true,
      // 1回目は承認済み通報、2回目は送信までに届いた通報だけが見える。
      precheck: () => {
        prepares += 1;
        return prepares === 1
          ? { openReportIds: ["connector-report-96533"] }
          : { openReportIds: ["connector-report-late-96533"] };
      },
      afterSubmit: () => ["connector-report-late-96533"],
      remainingOpenReportIds: () => ["connector-report-late-96533"],
    };
  })(),
  // 承認後に増えた通報は、同じ完了で一緒に閉じる。
  96525: {
    effect: true,
    precheck: { openReportIds: ["connector-report-96525", "connector-report-extra"] },
    expectSubmission: ({ reportIds }) =>
      reportIds.length === 2 &&
      reportIds.includes("connector-report-96525") &&
      reportIds.includes("connector-report-extra"),
  },
  // 通報を必要としない操作は、通報表を読めないことだけでは止めない。
  96526: { effect: true, precheck: { openReportIds: [], reportsUnavailable: true } },
  // 送らなくても承認済みの到達点に達している分岐。送信されないことを確かめる。
  96522: { submitMustNotHappen: true, precheck: { currentState: "削除済み" } },
  96527: {
    submitMustNotHappen: true,
    precheck: { openReportIds: [], closedReportIds: ["connector-report-96527"] },
  },
  // 送らずに確定した後で対象が公開中へ戻る分岐。確定済みの操作は照合を繰り返さず、
  // 記録済みの結果をそのまま返すことを確かめる。
  96530: {
    submitMustNotHappen: true,
    precheck: (() => {
      let reads = 0;
      return () => (reads++ === 0 ? { currentState: "削除済み" } : {});
    })(),
  },
  // 対象が先に削除済みだった通報完了。承認時に確定した代替本文だけを送る。
  96528: {
    effect: true,
    precheck: {
      currentState: "削除済み",
      openReportIds: ["connector-report-96528"],
    },
    expectSubmission: ({ message }) =>
      typeof message === "string" && message.startsWith("削除済みだった場合"),
  },
  // 承認済みの削除で削除済みになった通報完了。代替本文へ切り替えず通常の本文を送る。
  // 削除の前後で状態が変わるので、`precheck`は原子操作ごとに返す。
  96529: {
    effect: true,
    precheck: ({ operationType }) =>
      operationType === "comment_delete" ? {} : { currentState: "削除済み" },
    expectSubmission: ({ operationType, message }) =>
      operationType === "comment_delete"
        ? message === undefined
        : message === "通常の回答です。",
  },
};

function recordCall(type, request) {
  if (process.env.ZAWAZAWA_TEST_EXECUTION_LOG) appendFileSync(process.env.ZAWAZAWA_TEST_EXECUTION_LOG,
    JSON.stringify({ type, commentNumber: request.commentNumber, reportIds: request.reportIds || [] }) + "\n");
}

export function createZawazawaConnector() {
  return {
    async reconcileApprovedOperation(request) {
      recordCall("readback", request);
      return { effect: request.commentNumber === "96518" };
    },
    async prepareApprovedOperation(request) {
      if (request.commentNumber === "96552" && process.env.ZAWAZAWA_TEST_EXECUTION_LOG) {
        recordCall("prepare_waiting", request);
        const releasePath = `${process.env.ZAWAZAWA_TEST_EXECUTION_LOG}.release`;
        while (!existsSync(releasePath)) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const behavior = EXECUTION_BEHAVIOR[request.commentNumber] || {};
      if (behavior.prepareErrorCode) {
        throw new ZawazawaConnectorError(
          behavior.prepareErrorCode,
          "モックが送信前に拒否しました。",
        );
      }
      return {
        precheck: {
          currentState: "公開中",
          openReportIds: [`connector-report-${request.commentNumber}`],
          closedReportIds: [],
          reportsUnavailable: false,
          // 同じ対象でも、承認済み操作の実行で状態が変わる分岐があるので、原子操作
          // ごとに差し替えられるようにする。
          ...(typeof behavior.precheck === "function"
            ? behavior.precheck(request)
            : behavior.precheck),
        },
        bind: (overrides = {}) => ({
          submit: async () => {
            recordCall("submit", { ...request, ...overrides });
            if (behavior.submitMustNotHappen) {
              throw new ZawazawaConnectorError(
                "unknown",
                "実行直前照合で止まる操作が送信されました。",
              );
            }
            // 実行直前照合の結果で、閉じる通報と送る本文が承認済みの値から選び直される。
            // 想定と違う送信は成功にせず、その場で失敗として出す。
            if (
              behavior.expectSubmission &&
              !behavior.expectSubmission({
                operationType: request.operationType,
                reportIds: overrides.reportIds || request.reportIds || [],
                message: overrides.message ?? request.message,
              })
            ) {
              throw new ZawazawaConnectorError(
                "unknown",
                "承認内容と違う送信が行われました。",
              );
            }
            const submittedReportIds = overrides.reportIds || request.reportIds || [];
            return {
              status: 200,
              // 同じ対象でも、承認済み通報の完了と追加分の完了で結果が違う分岐がある。
              effect:
                typeof behavior.effect === "function"
                  ? behavior.effect(submittedReportIds)
                  : behavior.effect,
              // 送信後にその対象へ残っている未処理通報。読めない画面では`undefined`。
              openReportIds: behavior.afterSubmit?.(submittedReportIds),
              rejected: false,
            };
          },
          readback: async () => ({
            effect: behavior.readback,
            openReportIds: behavior.remainingOpenReportIds?.(),
          }),
        }),
      };
    },

    async getComments(requests) {
      return requests.map((request) => ({
        commentNumber: request.commentNumber,
        topicNumber: request.topicNumber,
        body: "管理画面から解決した対象本文",
        currentState: "公開中",
        publicUrl: `https://z.wikiwiki.jp/${request.groupKey}/topic/${request.topicNumber}/${request.commentNumber}`,
        openReports: [
          {
            reportId: `connector-report-${request.commentNumber}`,
            reason: "管理画面から解決した通報理由",
            createdAt: "2026/08/22 10:00",
            repeatAfterResponse: false,
          },
        ],
        closedReports: [],
      }));
    },

    async getOpenReports() {
      return {
        reports: [],
        totalCount: 0,
        totalCountConfirmed: true,
        completeness: "complete",
        truncated: false,
      };
    },

    async close() {},
  };
}
