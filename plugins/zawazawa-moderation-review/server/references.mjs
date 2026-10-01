import { ZawazawaConnectorError, connectorErrorCode } from "./identifiers.mjs";
import { adminCommentUrl, publicCommentUrl } from "./admin-reader.mjs";
import { recoveryForErrorCode } from "./error-codes.mjs";

/** コネクタ由来の失敗を、文言ではなくコードで判別できる形で返す。 */
export function connectorErrorResult(error) {
  const errorCode = connectorErrorCode(error);
  // 型の付かない内部例外は取得ライブラリ由来の値やURLを含み得る。コネクタが
  // 明示的に分類した固定文だけを返し、それ以外のcauseは外へ出さない。
  const message =
    error instanceof ZawazawaConnectorError
      ? error.message
      : "ZAWAZAWAの読み取りを安全に完了できませんでした。";
  // 文言は`content`だけに載せる。モデルは`errorCode`と`nextAction`で次の行動を決める。
  return {
    isError: true,
    structuredContent: { errorCode, ...recoveryForErrorCode(errorCode) },
    content: [{ type: "text", text: `[${errorCode}] ${message}` }],
  };
}

function referenceKey({ groupKey, topicNumber, commentNumber }) {
  return `${groupKey}/${topicNumber}/${commentNumber}`;
}

function collectPending(items, groupKey) {
  const pending = [];
  for (const item of items) {
    const operatedNumbers = new Set(
      (item.recommendation?.targets || []).map((target) => target.commentNumber),
    );
    // 処置対象、コメントの役割、コメント行の対処案は、処理単位の中をコメント番号だけで
    // 指す。別トピックの文脈を同じ単位へ入れて番号が重なると、どの投稿への操作なのかが
    // 一意に決まらない。表示の乱れでは済まないので、取得の前に止める。
    const topicByComment = new Map();
    for (const key of ["comments", "history"]) {
      for (const entry of item[key] || []) {
        if (!entry.topicNumber || !entry.commentNumber) {
          throw new ZawazawaConnectorError(
            "invalid_input",
            `投稿ID ${item.id} の${key}にはtopicNumberとcommentNumberの参照が必要です。`,
          );
        }
        if (key === "comments") {
          const known = topicByComment.get(entry.commentNumber);
          if (known && known !== entry.topicNumber) {
            throw new ZawazawaConnectorError(
              "invalid_input",
              `投稿ID ${item.id} のコメント参照で、コメント番号${entry.commentNumber}がトピック${known}とトピック${entry.topicNumber}に重複しています。処理単位はコメント番号で対象を指すため、番号の重なる文脈は別の単位で扱ってください。`,
            );
          }
          topicByComment.set(entry.commentNumber, entry.topicNumber);
        }
        pending.push({
          entry,
          // 処置対象と投稿履歴は、現在状態と原文が要るので管理画面から読む。
          // それ以外の文脈コメントは公開ページで足りる。
          operated: key === "history" || operatedNumbers.has(entry.commentNumber),
          request: {
            groupKey,
            topicNumber: entry.topicNumber,
            commentNumber: entry.commentNumber,
          },
        });
      }
    }
  }
  return pending;
}

function applyAdminDetail(entry, detail) {
  entry.body = detail.body;
  entry.createdAt = entry.createdAt || detail.createdAt;
  entry.currentState = entry.currentState || detail.currentState;
  entry.url = entry.url || detail.publicUrl;
  if (detail.parentCommentNumber && !entry.parentCommentNumber) {
    entry.parentCommentNumber = detail.parentCommentNumber;
  }
}

function applyPublicComment(entry, comment, request) {
  entry.body = comment.body;
  entry.createdAt = entry.createdAt || comment.createdAt;
  entry.displayName = entry.displayName || comment.displayName;
  // 公開ページに描画されている事実そのものを状態として使う。
  entry.currentState = entry.currentState || "公開中";
  entry.url = entry.url || publicCommentUrl(request);
  if (comment.parentCommentNumber && !entry.parentCommentNumber) {
    entry.parentCommentNumber = comment.parentCommentNumber;
  }
}

/**
 * 処置対象でない文脈コメントを、認証もブラウザも使わない公開ページから埋める。
 * 公開ページに無い（削除済み・非表示）ものと、読み取りに失敗したものは
 * 管理画面へ回す。効率化のために取得できない本文を作らない。
 */
async function fillFromPublicPages(pending, publicReader) {
  const remaining = [];
  const groups = new Map();
  for (const item of pending) {
    if (item.operated) {
      remaining.push(item);
      continue;
    }
    const key = `${item.request.groupKey}/${item.request.topicNumber}`;
    const group = groups.get(key) || { request: item.request, members: [] };
    group.members.push(item);
    groups.set(key, group);
  }

  for (const group of groups.values()) {
    let comments;
    try {
      const result = await publicReader.collectComments(
        { groupKey: group.request.groupKey, topicNumber: group.request.topicNumber },
        group.members.map((member) => member.request.commentNumber),
      );
      comments = result.comments;
    } catch {
      // 公開ページが読めないことは失敗にしない。管理画面の経路がそのまま残る。
      remaining.push(...group.members);
      continue;
    }
    for (const member of group.members) {
      const comment = comments.get(member.request.commentNumber);
      if (comment?.body) {
        applyPublicComment(member.entry, comment, member.request);
      } else {
        remaining.push(member);
      }
    }
  }
  return remaining;
}

/**
 * 通報を読む対象を決める。すべての処置対象は一覧入力のコメント参照に存在し、
 * 管理画面で現在状態と未処理通報を確認できなければならない。
 */
function planReports(items, groupKey) {
  const plans = new Map();
  for (const item of items) {
    // 処置対象が無ければ、確認すべき通報の対象も無い。
    const targets = item.recommendation?.targets || [];
    if (!targets.length) continue;

    const topicByComment = new Map();
    for (const entry of item.comments || []) {
      if (entry.topicNumber) topicByComment.set(entry.commentNumber, entry.topicNumber);
    }
    const requests = [];
    for (const target of targets) {
      const topicNumber = topicByComment.get(target.commentNumber);
      if (topicNumber) {
        requests.push({ groupKey, topicNumber, commentNumber: target.commentNumber });
      } else {
        throw new ZawazawaConnectorError(
          "invalid_input",
          `投稿ID ${item.id} の処置対象コメント${target.commentNumber}をcommentsの参照から解決できません。`,
        );
      }
    }
    // 単位レベルのリンクは処置の実行順ではなく、その単位自体のコメントを指す。
    // item.idが参照にあればそれを、無ければ最初の処置対象を代表にする。
    const anchorTopicNumber = topicByComment.get(item.id);
    plans.set(item, {
      requests,
      anchor: anchorTopicNumber
        ? { groupKey, topicNumber: anchorTopicNumber, commentNumber: item.id }
        : requests[0],
    });
  }
  return plans;
}

/** 表題へ並べるコメント番号の上限。残りは件数へまとめ、見出しを一行に収める。 */
const MAX_TITLE_COMMENT_NUMBERS = 3;

/**
 * 一覧へ載せるトピック名の上限。トピック名は公開ページの描画から読むので長さの保証が
 * なく、そのまま通すと保存済み一覧と見出しが一件で膨らむ。表題は単位に一つだが、行の
 * 出所は行の数だけ同じ名前を持つので、切らずに通すと膨らみ方はより大きい。見分けが付く
 * 長さで切り、切ったことが分かる形にする。
 */
const MAX_TOPIC_NAME_LENGTH = 60;

function shortTopicName(topicName) {
  return topicName.length > MAX_TOPIC_NAME_LENGTH
    ? `${topicName.slice(0, MAX_TOPIC_NAME_LENGTH)}…`
    : topicName;
}

function titleTopicName(topicName, topicNumber) {
  return topicName || `トピック${topicNumber}`;
}

/**
 * 処理単位の見出しを組み立てる。トピック名と処置対象のコメント番号だけで作り、判定も
 * 依存関係も入れない。何を実行するかは一覧の各列が示すためである。トピック名を読めない
 * 場合はトピック番号で代える。見出しは管理者が単位を見分ける目印であって判断材料では
 * ないので、名前が無いことで一覧を止めない。
 */
function unitTitle(topicName, topicNumber, commentNumbers) {
  const shown = commentNumbers
    .slice(0, MAX_TITLE_COMMENT_NUMBERS)
    .map((commentNumber) => `#${commentNumber}`)
    .join(" ");
  const rest = commentNumbers.length - MAX_TITLE_COMMENT_NUMBERS;
  const numbers = rest > 0 ? `${shown} ほか${rest}件` : shown;
  return `${titleTopicName(topicName, topicNumber)} ${numbers}`.trim();
}

/**
 * 一覧に出るトピックの名前を読む。表題のトピックだけでなく、文脈や投稿履歴として拾った
 * トピックも読む。番号だけでは、同じ単位に並ぶ行がどの掲示板の投稿なのかを管理者が
 * 見分けられないためである。トピック単位でまとめ、公開ページのreaderが無い場合と
 * 読めない場合は名前なしで返す。呼び出しはZAWAZAWAへ届くので順番に出す。
 *
 * 長さは読んだ直後に切る。表題も行の出所も同じ名前を載せるので、切る場所を一つにすると
 * 出し先が増えても長さの上限が揃う。
 */
async function resolveTopicNames(references, publicReader) {
  const names = new Map();
  if (!publicReader?.readTopicName) return names;
  for (const reference of references) {
    if (!reference || names.has(reference.topicNumber)) continue;
    const topicName = await publicReader.readTopicName(reference);
    names.set(reference.topicNumber, topicName ? shortTopicName(topicName) : topicName);
  }
  return names;
}

/**
 * 未処理通報を管理画面の記録で置き換える。通報理由を転記させないこと、通報ごとの
 * 識別子を持たせて実行直前の再確認で差分を取れるようにすること、処置対象に付いた
 * 通報を数え落とさないことが目的。あわせて処置対象の現在状態と単位レベルのリンクを
 * 同じ取得結果から埋める。
 *
 * 1ページに収まらない通報表では読めた行がその対象の全部にならない。読めた行だけを
 * 渡すと一覧は読めた件数を全部として出すため、打ち切りの有無と、分かる場合の総件数を
 * 処理単位の事実として同じ経路で持たせる。
 */
function applyReports(item, plan, detailByKey, topicNames) {
  const open = [];
  // 処置単位に付いた未処理通報を読み切れたか。対象が一つでも読み切れていなければ、
  // その単位の通報一覧は全部ではない。
  let truncated = false;
  // 読み切れていない対象の総件数。1件でも総件数が分からない対象があれば、単位の
  // 総件数も分からない。読めた件数で埋めると打ち切りの事実が消える。
  let totalCount = 0;
  let totalCountKnown = true;
  for (const request of plan.requests) {
    const detail = detailByKey.get(referenceKey(request));
    const reports = detail?.openReports;
    // 通報表を読めなかった対象を0件として通さない。本文の解決は続けられても、
    // 未処理通報の有無が未確認のまま判断へ進むのは通報の見落としになる。
    if (!reports) {
      const failure = detail?.reportsError;
      throw new ZawazawaConnectorError(
        failure?.code || "page_changed",
        `投稿ID ${item.id} の処置対象コメント${request.commentNumber}の未処理通報を確認できません${failure?.message ? `: ${failure.message}` : "。"}0件として扱わないでください。`,
      );
    }
    const target = item.recommendation.targets.find(
      (entry) => entry.commentNumber === request.commentNumber,
    );
    if (!detail.currentState) {
      throw new ZawazawaConnectorError(
        "page_changed",
        `投稿ID ${item.id} の処置対象コメント${request.commentNumber}の現在状態を確認できません。`,
      );
    }
    target.currentState = detail.currentState;
    target.url = detail.publicUrl;
    const truncatedHere = detail.openReportsTruncated === true;
    if (truncatedHere) truncated = true;
    // 読み切れた対象は読めた行数がそのまま総件数になる。読み切れていない対象は、管理画面の
    // 件数表示が読めた行より多いときだけ数えられる。読めた行数と同じ数を総件数として受けると、
    // 読み切れていないのに残りが0件という数になる。
    const targetTotalCount = truncatedHere
      ? Number.isSafeInteger(detail.openReportsTotalCount) &&
        detail.openReportsTotalCount > reports.length
        ? detail.openReportsTotalCount
        : undefined
      : reports.length;
    if (targetTotalCount === undefined) totalCountKnown = false;
    else totalCount += targetTotalCount;
    for (const report of reports) {
      open.push({
        reportId: report.reportId,
        targetCommentNumber: request.commentNumber,
        reason: report.reason,
        createdAt: report.createdAt,
        // 同じ通報者が回答済みの同じコメントを再通報したか。運用基準の`無視`条件の判定material。
        repeatAfterResponse: report.repeatAfterResponse === true,
      });
    }
  }
  item.reports = open;
  item.reportsTruncated = truncated;
  // 総件数は読み切れていない単位でだけ意味を持つ。読み切れた単位では通報行の数が
  // そのまま総件数なので、同じ数を二か所へ持たせない。
  if (truncated && totalCountKnown) item.reportTotalCount = totalCount;
  if (plan.anchor) {
    item.publicUrl = publicCommentUrl(plan.anchor);
    item.adminUrl = adminCommentUrl(plan.anchor);
    item.title = unitTitle(
      topicNames.get(plan.anchor.topicNumber),
      plan.anchor.topicNumber,
      plan.requests.map((request) => request.commentNumber),
    );
  }
}

/**
 * コメント・履歴の参照と、処置対象に付いた未処理通報を解決する。モデルに本文や通報理由を
 * 転記させず、取得元と同一の記録を使うための経路。公開側で足りるものは公開ページから
 * 読み、管理画面にしかない項目が要るものだけ管理画面を開く。
 *
 * `groupKey`は対象コンテキストから解決した唯一の対象で、item側には現れない。ここで
 * 欠けたまま進むと対象を持たないURLを組み立ててしまうため、取得の前に止める。
 */
export async function resolveItemReferences({ items, groupKey, connector, publicReader }) {
  if (!groupKey) {
    throw new ZawazawaConnectorError(
      "invalid_input",
      "対象グループが解決されていません。対象コンテキストを束縛し直してください。",
    );
  }
  const pending = collectPending(items, groupKey);
  const plans = planReports(items, groupKey);
  if (!pending.length && !plans.size) return items;

  const remaining = publicReader
    ? await fillFromPublicPages(pending, publicReader)
    : pending;
  // トピック名は1ページ目にあり、文脈を読んだトピックでは直前の取得キャッシュに当たる。
  // 管理画面の取得を挟むとその間にキャッシュが切れるので、公開ページの取得はここでまとめ、
  // 管理画面だけで解決したトピックのための1本だけを増やす。
  const topicNames = await resolveTopicNames(
    [...pending.map(({ request }) => request), ...[...plans.values()].map((plan) => plan.anchor)],
    publicReader,
  );

  const adminRequests = [];
  const seen = new Set();
  for (const request of [
    ...remaining.map(({ request }) => request),
    ...[...plans.values()].flatMap((plan) => plan.requests),
  ]) {
    const key = referenceKey(request);
    if (seen.has(key)) continue;
    seen.add(key);
    adminRequests.push(request);
  }

  // 通報表が要るのは処置対象だけ。文脈コメントと投稿履歴は本文と状態しか使わないので、
  // 同じ管理画面ページを通報表を読まない経路で解決する。
  const reportKeys = new Set(
    [...plans.values()].flatMap((plan) => plan.requests.map(referenceKey)),
  );

  const detailByKey = new Map();
  if (adminRequests.length) {
    const details = await connector.getComments(
      adminRequests.map((request) =>
        reportKeys.has(referenceKey(request))
          ? request
          : { ...request, includeReports: false },
      ),
    );
    adminRequests.forEach((request, index) => {
      detailByKey.set(referenceKey(request), details[index]);
    });
  }

  for (const { entry, request } of remaining) {
    applyAdminDetail(entry, detailByKey.get(referenceKey(request)));
  }
  for (const [item, plan] of plans) {
    applyReports(item, plan, detailByKey, topicNames);
  }

  // トピック番号と名前は行の出所を示すために残す。どのトピックの投稿かが分かって
  // はじめて、同一ツリー・別ツリー・別トピックの区別が一覧で読み取れる。
  for (const { entry, request } of pending) {
    delete entry.groupKey;
    const topicName = topicNames.get(request.topicNumber);
    if (topicName) entry.topicName = topicName;
  }
  return items;
}
