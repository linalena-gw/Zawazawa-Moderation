import { cleanText } from "./input-text.mjs";
import {
  GROUP_KEY,
  NUMBER,
  ZAWAZAWA_USER_AGENT,
  ZawazawaConnectorError,
} from "./identifiers.mjs";
import { htmlToText, loadDocument, loadXml } from "./html-parse.mjs";

export { htmlToText };

export const PUBLIC_BASE_URL = "https://z.wikiwiki.jp";
const DEFAULT_MAX_PAGES = 3;
const DEFAULT_TIMEOUT_MS = 15000;
// 同じ常駐サーバー内の一覧参照解決とツール呼び出しで公開ページを共有する。
// 公開文脈はライブ状態の証拠ではないため短時間に限り、取得時刻を必ず結果へ残す。
export const DEFAULT_PAGE_CACHE_TTL_MS = 15_000;
// 公開ページの1本あたりの上限。想定を超える応答で常駐プロセスの記憶域を食い潰さない。
// 管理画面readerと同じく、申告された長さを本文を読む前に見る。
export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_CONTEXT_BUDGET = 50;
const CONTEXT_MODES = new Set(["all_fetched", "target_trees"]);

const COMMENT_ID = /^comment-(\d+)$/u;
/**
 * トピック名の在り処。ZAWAZAWAが描画する見出し帯（`.title-block`）の直接の子であり、
 * 投稿者が触れる本文の外にある。本文中に同じ組み合わせが現れた場合は一意に定まらなく
 * なるので、そのときは名前を読まない。見出しは判断材料ではなく管理者の目印なので、
 * 読めないことを失敗にはせず、番号だけの表題へ落とす。
 */
const TOPIC_NAME_SELECTOR = ".title-block > h2.page-title";

/** そのノードを直接含むコメント要素。枝の中身を親のものとして数えないために見る。 */
function ownerComment($, node) {
  return $(node)
    .parents()
    .toArray()
    .find((parent) => COMMENT_ID.test(parent.attribs?.id || ""));
}

/**
 * コメント自身に属する最初の要素を返す。枝は親要素の内側に入るため、
 * 単純な子孫検索では枝の返信元リンクや本文を親のものとして拾ってしまう。
 */
function ownFirst($, comment, selector) {
  for (const node of comment.find(selector).toArray()) {
    if (ownerComment($, node) === comment[0]) return $(node);
  }
  return $([]);
}

/**
 * 公開トピックページから、描画されているコメントを読む。
 * 枝は親の内側に入るため、各項目はコメント自身に属する要素だけから読む。
 */
export function parseTopicPage(html) {
  const $ = loadDocument(html);

  const comments = $('[id^="comment-"]')
    .toArray()
    .map((element) => ({ comment: $(element), match: COMMENT_ID.exec($(element).attr("id")) }))
    .filter((entry) => entry.match)
    .map(({ comment, match }) => {
      const first = (selector) => ownFirst($, comment, selector);
      const parentHref = first(".comment-parent-link").attr("href");
      const parentMatch = parentHref?.match(/\/(\d+)\s*$/u);
      return {
        commentNumber: match[1],
        body: cleanText(htmlToText(first(".body"))),
        displayName: cleanText(first(".posted-user").text()) || undefined,
        createdAt: cleanText(first(".comment-timestamp").text()) || undefined,
        parentCommentNumber: parentMatch ? parentMatch[1] : undefined,
      };
    });

  // ページ送りは`a`に限らないので、`href`を持つ要素すべてから読む。実体参照を復号した
  // `href`はここでだけ正しく読めるが、リンク以外（データ属性や埋め込みJSON）に
  // ページ送りが出る描画では取りこぼす。取りこぼしは「これ以上ページが無い」という
  // 主張になり、読み残しを読み残しとして返せなくなるため、原文の走査も重ねて拾う。
  // 余分に拾った番号は空ページを1枚読むだけで、未確認を0件と言うより安全側に倒れる。
  const pageNumbers = new Set();
  for (const element of $("[href]").toArray()) {
    const match = /[?&]page=(\d+)(?![0-9])/u.exec($(element).attr("href"));
    if (match) pageNumbers.add(Number(match[1]));
  }
  for (const entry of html.matchAll(/[?&]page=(\d+)(?![0-9])/gu)) {
    pageNumbers.add(Number(entry[1]));
  }

  // 一意に特定できた見出しだけをトピック名にする。
  const topicNames = $(TOPIC_NAME_SELECTOR);
  const topicName =
    topicNames.length === 1 ? cleanText(topicNames.first().text()) || undefined : undefined;

  return {
    comments,
    topicName,
    maxCommentNumber: $("[data-max-comment-number]").first().attr("data-max-comment-number"),
    pageNumbers: [...pageNumbers].sort((left, right) => left - right),
  };
}

/**
 * トピックのRSSは本文が途中で切れるため、番号・投稿者・日時の索引としてだけ使う。
 * `description`はHTMLの断片で、CDATAで包む描画と実体参照で包む描画の両方がありうる。
 * どちらも同じ可視テキストへ落として、包み方の違いがプレビューの文面に出ないようにする。
 */
export function parseTopicFeed(xml) {
  const $ = loadXml(xml);
  return $("item")
    .toArray()
    .map((element) => {
      const item = $(element);
      const field = (name) => cleanText(item.find(name).first().text());
      const numbers = field("link").match(/\/topic\/(\d+)\/(\d+)\s*$/u);
      if (!numbers) return null;
      return {
        topicNumber: numbers[1],
        commentNumber: numbers[2],
        displayName: field("dc\\:creator") || undefined,
        createdAt: field("dc\\:date") || undefined,
        preview: cleanText(htmlToText(field("description"))) || undefined,
      };
    })
    .filter(Boolean);
}

function assertReference({ groupKey, topicNumber }) {
  if (!GROUP_KEY.test(groupKey)) {
    throw new ZawazawaConnectorError("invalid_input", "グループキーの形式が不正です。");
  }
  if (!NUMBER.test(topicNumber)) {
    throw new ZawazawaConnectorError("invalid_input", "トピック番号の形式が不正です。");
  }
}

function assertPage(page) {
  if (!Number.isInteger(page) || page < 1) {
    throw new ZawazawaConnectorError("invalid_input", "ページ番号の形式が不正です。");
  }
}

function normalizeContextOptions(wantedNumbers, options) {
  let wanted = wantedNumbers;
  let projection = options;
  // 読み取り層を直接使う呼び出し側は、番号と射影を一つのオブジェクトでも渡せる。
  if (!Array.isArray(wantedNumbers) && wantedNumbers && typeof wantedNumbers === "object") {
    projection = wantedNumbers;
    wanted =
      projection.targetCommentNumbers ||
      projection.aroundCommentNumbers ||
      projection.wantedNumbers ||
      [];
  }

  const targetCommentNumbers = [...new Set(wanted || [])];
  for (const number of targetCommentNumbers) {
    if (!NUMBER.test(number)) {
      throw new ZawazawaConnectorError("invalid_input", "コメント番号の形式が不正です。");
    }
  }

  const mode = projection?.mode || "all_fetched";
  if (!CONTEXT_MODES.has(mode)) {
    throw new ZawazawaConnectorError(
      "invalid_input",
      "公開文脈のmodeはall_fetchedまたはtarget_treesで指定してください。",
    );
  }

  const budgets = {};
  for (const key of ["siblingRadius", "before", "after"]) {
    const value = projection?.[key] ?? 0;
    if (!Number.isInteger(value) || value < 0 || value > MAX_CONTEXT_BUDGET) {
      throw new ZawazawaConnectorError(
        "invalid_input",
        `${key}は0から${MAX_CONTEXT_BUDGET}の整数で指定してください。`,
      );
    }
    budgets[key] = value;
  }
  return { mode, targetCommentNumbers, ...budgets };
}

function addRequiredAncestors(found, targetCommentNumbers) {
  const required = new Set(targetCommentNumbers);
  for (const targetNumber of targetCommentNumbers) {
    let current = found.get(targetNumber);
    const seen = new Set([targetNumber]);
    while (current?.parentCommentNumber && !seen.has(current.parentCommentNumber)) {
      const parentNumber = current.parentCommentNumber;
      seen.add(parentNumber);
      required.add(parentNumber);
      current = found.get(parentNumber);
    }
  }
  return required;
}

/** 20桁までの番号をIEEE 754へ落とさず、正の10進整数として比較する。 */
function compareCommentNumbers(left, right) {
  const normalizedLeft = left.replace(/^0+(?=[0-9])/u, "");
  const normalizedRight = right.replace(/^0+(?=[0-9])/u, "");
  if (normalizedLeft.length !== normalizedRight.length) {
    return normalizedLeft.length - normalizedRight.length;
  }
  return normalizedLeft < normalizedRight ? -1 : normalizedLeft > normalizedRight ? 1 : 0;
}

function numberOrder(left, right) {
  return compareCommentNumbers(left.commentNumber, right.commentNumber);
}

function siblingSides(target, ordered) {
  if (!target) return { before: [], after: [] };
  const siblings = ordered.filter(
    (comment) =>
      comment.commentNumber !== target.commentNumber &&
      comment.parentCommentNumber === target.parentCommentNumber,
  );
  return {
    before: siblings.filter(
      (comment) => compareCommentNumbers(comment.commentNumber, target.commentNumber) < 0,
    ),
    after: siblings.filter(
      (comment) => compareCommentNumbers(comment.commentNumber, target.commentNumber) > 0,
    ),
  };
}

function availableBudgetCounts(target, ordered) {
  if (!target) return undefined;
  const targetIndex = ordered.findIndex(
    (comment) => comment.commentNumber === target.commentNumber,
  );
  const siblings = siblingSides(target, ordered);
  return {
    before: targetIndex,
    after: targetIndex < 0 ? 0 : ordered.length - targetIndex - 1,
    siblingBefore: siblings.before.length,
    siblingAfter: siblings.after.length,
  };
}

/** 古いページを追加すれば満たせる可能性がある明示予算が残っているか。 */
function needsOlderBudgetPage(found, context) {
  if (context.mode !== "target_trees") return false;
  const ordered = [...found.values()].sort(numberOrder);
  return context.targetCommentNumbers.some((targetCommentNumber) => {
    const available = availableBudgetCounts(found.get(targetCommentNumber), ordered);
    return (
      available &&
      (available.before < context.before || available.siblingBefore < context.siblingRadius)
    );
  });
}

function ancestorsOf(target, found) {
  const ancestors = [];
  const seen = new Set([target?.commentNumber]);
  let parentNumber = target?.parentCommentNumber;
  while (parentNumber && !seen.has(parentNumber)) {
    seen.add(parentNumber);
    const parent = found.get(parentNumber);
    if (!parent) break;
    ancestors.push(parent);
    parentNumber = parent.parentCommentNumber;
  }
  return ancestors;
}

function isDescendantOf(comment, targetNumber, found) {
  const seen = new Set([comment.commentNumber]);
  let parentNumber = comment.parentCommentNumber;
  while (parentNumber && !seen.has(parentNumber)) {
    if (parentNumber === targetNumber) return true;
    seen.add(parentNumber);
    parentNumber = found.get(parentNumber)?.parentCommentNumber;
  }
  return false;
}

/**
 * 対象自体・祖先の不在とは別に、明示した文脈予算を満たせなかった方向を返す。
 * 古い側はページ上限かトピック先頭かを区別し、新しい側はpage 1まで読んだ時点で
 * トピック末尾まで確認済みなのでtopic_boundaryになる。
 */
function collectContextBudgetShortfalls(targetTrees, context, hasOlderPage) {
  if (!targetTrees) return [];
  const shortfalls = [];
  for (const tree of targetTrees) {
    if (!tree.targetAvailable) continue;
    const returnedCounts = {
      before: tree.beforeCommentNumbers.length,
      after: tree.afterCommentNumbers.length,
      siblingBefore: tree.siblingCommentNumbers.filter(
        (commentNumber) => compareCommentNumbers(commentNumber, tree.targetCommentNumber) < 0,
      ).length,
      siblingAfter: tree.siblingCommentNumbers.filter(
        (commentNumber) => compareCommentNumbers(commentNumber, tree.targetCommentNumber) > 0,
      ).length,
    };
    const requestedCounts = {
      before: context.before,
      after: context.after,
      siblingBefore: context.siblingRadius,
      siblingAfter: context.siblingRadius,
    };
    for (const budget of ["before", "after", "siblingBefore", "siblingAfter"]) {
      const requestedCount = requestedCounts[budget];
      const returnedCount = returnedCounts[budget];
      if (!requestedCount || returnedCount >= requestedCount) continue;
      const olderDirection = budget === "before" || budget === "siblingBefore";
      shortfalls.push({
        targetCommentNumber: tree.targetCommentNumber,
        budget,
        requestedCount,
        returnedCount,
        shortfallCount: requestedCount - returnedCount,
        reason: olderDirection && hasOlderPage ? "page_limit" : "topic_boundary",
      });
    }
  }
  return shortfalls;
}

/** 取得済みの広いページ集合から、指定対象の木と明示予算だけを返す。 */
function projectTargetTrees(found, targetCommentNumbers, { siblingRadius, before, after }) {
  const ordered = [...found.values()].sort(numberOrder);
  const returned = new Map();
  const targetTrees = targetCommentNumbers.map((targetCommentNumber) => {
    const target = found.get(targetCommentNumber);
    const ancestors = target ? ancestorsOf(target, found) : [];
    // 対象自体が削除・非表示またはページ上限外でも、親リンクから対象へ到達できる
    // 取得済みの子孫は既知の文脈である。意図的な省略へ誤分類しない。
    const descendants = ordered.filter((comment) =>
      isDescendantOf(comment, targetCommentNumber, found),
    );

    const siblingCandidates = siblingSides(target, ordered);
    const siblings = siblingRadius
      ? [
          ...siblingCandidates.before.slice(-siblingRadius),
          ...siblingCandidates.after.slice(0, siblingRadius),
        ]
      : [];

    const targetIndex = target
      ? ordered.findIndex((comment) => comment.commentNumber === targetCommentNumber)
      : -1;
    const beforeComments =
      targetIndex < 0 ? [] : ordered.slice(Math.max(0, targetIndex - before), targetIndex);
    const afterComments =
      targetIndex < 0 ? [] : ordered.slice(targetIndex + 1, targetIndex + 1 + after);

    for (const comment of [
      ...(target ? [target] : []),
      ...ancestors,
      ...descendants,
      ...siblings,
      ...beforeComments,
      ...afterComments,
    ]) {
      returned.set(comment.commentNumber, comment);
    }

    // 木は本文を持たず番号だけを並べる。本文は`comments`に1回だけ載るので、
    // 同じコメントが複数の対象・複数の役割に現れても返却量が増えない。
    const numbersOf = (comments) => comments.map((comment) => comment.commentNumber);
    return {
      targetCommentNumber,
      // 不在をプロパティ省略にすると、対象を返し忘れた成功と区別できない。
      targetAvailable: Boolean(target),
      ancestorCommentNumbers: numbersOf(ancestors),
      descendantCommentNumbers: numbersOf(descendants),
      siblingCommentNumbers: numbersOf(siblings),
      beforeCommentNumbers: numbersOf(beforeComments),
      afterCommentNumbers: numbersOf(afterComments),
    };
  });
  // 本文は番号順に1本の列として読めるようにする。並びは木の番号列が持つ。
  const orderedReturned = new Map(
    [...returned.values()].sort(numberOrder).map((comment) => [comment.commentNumber, comment]),
  );
  return { comments: orderedReturned, targetTrees };
}

/**
 * 公開ページの読み取り。認証もブラウザも使わないため、
 * 前後文脈と、個別の理由がある場合の公開反映をHTTP取得だけで確認できる。
 * 公開側の不在は削除と非表示を区別できないため、削除成功の証拠には使わない。
 * 管理画面にしかない現在状態・通報・接続元はここでは扱わない。
 */
export function createPublicReader(options = {}) {
  const baseUrl = options.baseUrl || PUBLIC_BASE_URL;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const userAgent =
    options.userAgent || process.env.ZAWAZAWA_PUBLIC_USER_AGENT || ZAWAZAWA_USER_AGENT;
  const maxPages = options.maxPages || DEFAULT_MAX_PAGES;
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const pageCacheTtlMs = options.pageCacheTtlMs ?? DEFAULT_PAGE_CACHE_TTL_MS;
  const now = options.now || Date.now;
  const requestLimiter = options.requestLimiter;
  const pageCache = new Map();

  if (!Number.isFinite(pageCacheTtlMs) || pageCacheTtlMs < 0) {
    throw new TypeError("pageCacheTtlMsは0以上の数値で指定してください。");
  }

  async function unrestrictedRequest(path) {
    let response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        headers: { "user-agent": userAgent, "accept-language": "ja" },
        redirect: "follow",
        // Nodeのfetchは既定で待ち続ける。上限を置かないと1本の停止で
        // ツールが返らなくなる（可視性確認は最大50件を順に取得する）。
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (cause) {
      if (cause?.name === "TimeoutError" || cause?.name === "AbortError") {
        throw new ZawazawaConnectorError(
          "timed_out",
          `ZAWAZAWAの公開ページが${timeoutMs}ミリ秒以内に応答しませんでした。間隔を置いて再試行してください。`,
        );
      }
      throw new ZawazawaConnectorError(
        "unknown",
        "ZAWAZAWAの公開ページを取得できませんでした。接続状態を確認して再試行してください。",
      );
    }
    if (response.status === 404) {
      throw new ZawazawaConnectorError(
        "not_found",
        "公開ページに該当の対象がありません。削除済みか、公開されていない可能性があります。",
      );
    }
    if (response.status === 403) {
      throw new ZawazawaConnectorError(
        "blocked",
        "ZAWAZAWAが公開ページへの自動アクセスをHTTP 403で拒否しました。認証済みの経路へ切り替えてください。",
      );
    }
    if (response.status === 429 || response.status === 503) {
      throw new ZawazawaConnectorError(
        "rate_limited",
        `ZAWAZAWAがHTTP ${response.status}を返しました。一時的な制限または保守中です。間隔を置いて再試行してください。`,
      );
    }
    if (!response.ok) {
      throw new ZawazawaConnectorError(
        "unknown",
        `ZAWAZAWAの公開ページがHTTP ${response.status}を返しました。`,
      );
    }
    const tooLarge = () =>
      new ZawazawaConnectorError(
        "page_changed",
        "公開ページの応答が想定より大きすぎます。読み取らずに中止しました。",
      );
    const declaredLength = Number(response.headers?.get?.("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
      throw tooLarge();
    }
    const text = await response.text();
    // 文字数ではなくUTF-8のバイト数で数える。日本語のページでは文字数の3倍近い
    // バイト数になり、文字数で数えると実効上限が契約値から大きくずれる。
    if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) throw tooLarge();
    return text;
  }

  function request(path) {
    const read = () => unrestrictedRequest(path);
    return requestLimiter ? requestLimiter.run(read) : read();
  }

  function topicPath({ groupKey, topicNumber }, page) {
    const base = `/${groupKey}/topic/${topicNumber}`;
    return page && page > 1 ? `${base}?page=${page}` : base;
  }

  async function readTopicPage(reference, page = 1) {
    assertReference(reference);
    assertPage(page);
    const cacheKey = `${reference.groupKey}/${reference.topicNumber}/${page}`;
    const currentTime = Number(now());
    for (const [key, entry] of pageCache) {
      if (entry.settled && entry.expiresAt <= currentTime) pageCache.delete(key);
    }
    const cached = pageCache.get(cacheKey);
    if (cached && (!cached.settled || cached.expiresAt > currentTime)) {
      return cached.promise;
    }
    if (cached) pageCache.delete(cacheKey);

    const entry = { settled: false, expiresAt: Number.POSITIVE_INFINITY, promise: undefined };
    entry.promise = request(topicPath(reference, page))
      .then((html) => {
        const checkedTime = Number(now());
        entry.settled = true;
        entry.expiresAt = checkedTime + pageCacheTtlMs;
        return {
          ...parseTopicPage(html),
          checkedAt: new Date(checkedTime).toISOString(),
        };
      })
      .catch((error) => {
        if (pageCache.get(cacheKey) === entry) pageCache.delete(cacheKey);
        throw error;
      });
    pageCache.set(cacheKey, entry);
    return entry.promise;
  }

  return {
    readTopicPage,

    /**
     * トピック名だけを読む。1ページ目は文脈取得でも必ず読むので、同じトピックを
     * 読んだ直後は取得キャッシュに当たり、往復は増えない。名前は表題にしか使わず、
     * 読めない場合は呼び出し側が番号だけの表題へ落とす。
     */
    async readTopicName(reference) {
      try {
        return (await readTopicPage(reference, 1)).topicName;
      } catch {
        return undefined;
      }
    },

    async readTopicFeed(reference) {
      assertReference(reference);
      return parseTopicFeed(await request(`${topicPath(reference)}/rss`));
    },

    /**
     * 求めるコメント番号・祖先と、古い側の明示文脈予算が揃うまで新しいページから遡る。
     * 番号指定がない場合は最新ページだけを読む。
     */
    async collectComments(reference, wantedNumbers, options = {}) {
      assertReference(reference);
      const context = normalizeContextOptions(wantedNumbers, options);
      const wanted = new Set(context.targetCommentNumbers);
      const found = new Map();
      const pagesRead = [];
      const checkedTimes = [];
      let maxCommentNumber;
      let unresolved = new Set(wanted);
      let hasOlderPage = false;
      let page = 1;
      for (;;) {
        const parsed = await readTopicPage(reference, page);
        pagesRead.push(page);
        checkedTimes.push(parsed.checkedAt);
        if (!maxCommentNumber && parsed.maxCommentNumber) {
          maxCommentNumber = parsed.maxCommentNumber;
        }
        for (const comment of parsed.comments) {
          if (!found.has(comment.commentNumber)) found.set(comment.commentNumber, comment);
        }
        const required = addRequiredAncestors(found, context.targetCommentNumbers);
        unresolved = new Set([...required].filter((number) => !found.has(number)));
        hasOlderPage = parsed.pageNumbers.some((number) => number > page);
        const olderBudgetPending = needsOlderBudgetPage(found, context);
        if (
          (!unresolved.size && !olderBudgetPending) ||
          !hasOlderPage ||
          pagesRead.length >= maxPages
        ) {
          break;
        }
        page += 1;
      }

      const projected =
        context.mode === "target_trees"
          ? projectTargetTrees(found, context.targetCommentNumbers, context)
          : { comments: found, targetTrees: undefined };
      const omittedCommentNumbers = [...found.keys()].filter(
        (number) => !projected.comments.has(number),
      );
      const unavailableCommentNumbers = hasOlderPage ? [...unresolved] : [];
      const missingCommentNumbers = hasOlderPage ? [] : [...unresolved];
      const contextBudgetShortfalls = collectContextBudgetShortfalls(
        projected.targetTrees,
        context,
        hasOlderPage,
      );
      // 複数ページの一部だけが古いキャッシュなら、最も古い取得時刻を結果全体の時刻にする。
      const checkedAt = checkedTimes.slice().sort()[0];
      const legacyMissing = [...wanted].filter((number) => !found.has(number));
      return {
        mode: context.mode,
        comments: projected.comments,
        ...(projected.targetTrees ? { targetTrees: projected.targetTrees } : {}),
        checkedAt,
        pagesRead,
        maxCommentNumber,
        fetchedCommentCount: found.size,
        returnedCommentCount: projected.comments.size,
        omittedCommentNumbers,
        omittedCommentCount: omittedCommentNumbers.length,
        unavailableCommentNumbers,
        missingCommentNumbers,
        contextBudgetShortfalls,
        // 旧呼び出し側は要求対象の不在だけをこの名前で読む。新しいコードは上の2分類を使う。
        missing: legacyMissing,
        truncated: Boolean(
          unavailableCommentNumbers.length ||
            contextBudgetShortfalls.some((entry) => entry.reason === "page_limit"),
        ),
      };
    },

    clearPageCache() {
      pageCache.clear();
    },

    /** 任意の公開反映確認用。不在を削除成功の証拠にせず、描画の有無だけを返す。 */
    async isPubliclyVisible({ groupKey, topicNumber, commentNumber }) {
      assertReference({ groupKey, topicNumber });
      if (!NUMBER.test(commentNumber)) {
        throw new ZawazawaConnectorError("invalid_input", "コメント番号の形式が不正です。");
      }
      let html;
      try {
        html = await request(`/${groupKey}/topic/${topicNumber}/${commentNumber}`);
      } catch (error) {
        if (error.code === "not_found") return false;
        throw error;
      }
      return parseTopicPage(html).comments.some(
        (comment) => comment.commentNumber === commentNumber,
      );
    },
  };
}
