const DEFAULT_CONFIRMATION_TIMEOUT_MS = 3000;
const DEFAULT_CLICK_TIMEOUT_MS = 10000;
const DEFAULT_POLL_INTERVAL_MS = 25;
const DEFAULT_TRIGGER_ATTEMPTS = 2;

// A confirmation can only be accepted by the same tab object after this
// helper opened and inspected it.  The entry is consumed at the start of
// acceptRenderedConfirmation so a failed or repeated acceptance cannot be
// retried through this module.  The status also makes overlapping open/accept
// calls fail closed.
const confirmationSessions = new WeakMap();

export class ConfirmingClickError extends Error {
  constructor(code, message, { actionMayHaveBeenDispatched = false } = {}) {
    super(message);
    this.name = "ConfirmingClickError";
    this.code = code;
    this.actionMayHaveBeenDispatched = actionMayHaveBeenDispatched;
  }
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function inspectTrigger(tab, expectedHref) {
  return tab.playwright.evaluate((expected) => {
    const matches = Array.from(document.querySelectorAll("a[href]")).filter(
      (element) => element.getAttribute("href") === expected.href,
    );
    if (matches.length !== 1) return { matchCount: matches.length };
    const [element] = matches;
    const rect = element.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const style = window.getComputedStyle(element);
    const hit = document.elementFromPoint(centerX, centerY);
    return {
      matchCount: 1,
      x: centerX,
      y: centerY,
      visible:
        rect.width > 0 &&
        rect.height > 0 &&
        centerX >= 0 &&
        centerY >= 0 &&
        centerX < window.innerWidth &&
        centerY < window.innerHeight &&
        style.visibility !== "hidden" &&
        style.display !== "none",
      hitTarget: hit === element || element.contains(hit),
    };
  }, { kind: "trigger", href: expectedHref });
}

async function inspectRenderedConfirmation(
  tab,
  { expectedHref, expectedConfirmText, expectedYesText, expectedNoText },
) {
  return tab.playwright.evaluate((expected) => {
    const normalize = (value) => String(value || "").replace(/\s+/gu, " ").trim();
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.visibility !== "hidden" &&
        style.display !== "none"
      );
    };
    const controlText = (element) =>
      normalize(
        element.tagName === "INPUT"
          ? element.value
          : element.getAttribute("aria-label") || element.textContent,
      );

    const baseHref =
      (typeof document.baseURI === "string" && document.baseURI) ||
      (typeof window.location?.href === "string" && window.location.href) ||
      undefined;
    const resolveHref = (value) => {
      if (typeof value !== "string" || !value.trim()) return null;
      try {
        return new URL(value, baseHref).href;
      } catch {
        return null;
      }
    };
    const expectedActionHref = resolveHref(expected.expectedHref);
    const associatedForm = (control) => {
      if (control.form) return control.form;
      const formId = control.getAttribute("form");
      if (formId && typeof document.getElementById === "function") {
        return document.getElementById(formId);
      }
      return control.closest?.("form") || null;
    };
    const effectiveAction = (control) => {
      const tagName = String(control.tagName || "").toUpperCase();
      if (tagName === "A") {
        return {
          href: resolveHref(control.getAttribute("href")),
          type: "anchor",
        };
      }

      if (tagName === "BUTTON") {
        const type = String(control.getAttribute("type") || "submit").toLowerCase();
        if (type !== "submit") return { href: null, type: "opaque" };
      } else if (tagName === "INPUT") {
        const type = String(control.getAttribute("type") || "text").toLowerCase();
        if (type !== "submit" && type !== "image") return { href: null, type: "opaque" };
      } else {
        return { href: null, type: "opaque" };
      }

      const form = associatedForm(control);
      if (!form) return { href: null, type: "unbound" };
      const override = control.getAttribute("formaction");
      const formAction = override !== null ? override : form.getAttribute("action") ?? form.action;
      return {
        href: resolveHref(formAction),
        type: "form",
      };
    };

    const messageElements = Array.from(
      document.querySelectorAll("h1,h2,h3,h4,h5,p,div,span"),
    ).filter(
      (element) =>
        visible(element) && normalize(element.textContent) === expected.confirmText,
    );
    const scopes = new Set(
      messageElements.map(
        (element) =>
          element.closest?.('dialog,[role="dialog"],form,.modal,.ui.modal') || null,
      ),
    );
    scopes.delete(null);
    const candidates = [];
    const valid = [];
    for (const scope of scopes) {
      const controls = Array.from(
        scope.querySelectorAll(
          'button,input[type="submit"],input[type="button"],[role="button"],a',
        ),
      ).filter(visible);
      const yesControls = controls.filter(
        (element) => controlText(element) === expected.yesText,
      );
      const noControls = controls.filter(
        (element) => controlText(element) === expected.noText,
      );
      if (yesControls.length >= 1 && noControls.length >= 1) {
        candidates.push({ scope, yesControls, noControls });
      }
      if (yesControls.length === 1 && noControls.length >= 1) valid.push({ scope, yes: yesControls[0] });
    }
    if (candidates.length !== 1 || valid.length !== 1 || !expectedActionHref) {
      return {
        present: false,
        candidateCount: candidates.length,
        matchCount: 0,
      };
    }

    const [candidate] = valid;
    const action = effectiveAction(candidate.yes);
    if (!action.href || action.href !== expectedActionHref) {
      return {
        present: false,
        candidateCount: candidates.length,
        matchCount: 0,
      };
    }

    const button = candidate.yes;
    const rect = button.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const hit = document.elementFromPoint(centerX, centerY);
    return {
      present: true,
      matchCount: 1,
      candidateCount: candidates.length,
      actionHref: action.href,
      bindingType: action.type,
      x: centerX,
      y: centerY,
      visible:
        centerX >= 0 &&
        centerY >= 0 &&
        centerX < window.innerWidth &&
        centerY < window.innerHeight,
      hitTarget: hit === button || button.contains(hit),
    };
  }, {
    kind: "confirmation",
    href: expectedHref,
    expectedHref,
    confirmText: expectedConfirmText,
    yesText: expectedYesText,
    noText: expectedNoText,
  });
}

async function clickWithTimeout(tab, clickPoint, timeoutMs) {
  let timeout;
  let timedOut = false;
  try {
    await Promise.race([
      tab.cua.click({ x: clickPoint.x, y: clickPoint.y }),
      new Promise((_, reject) => {
        timeout = setTimeout(() => {
          timedOut = true;
          reject(new Error("pointer click timed out"));
        }, timeoutMs);
      }),
    ]);
    return { completed: true, timedOut: false };
  } catch (error) {
    return { completed: false, timedOut, error };
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForRenderedConfirmation(tab, expected, timeoutMs, pollIntervalMs) {
  const deadline = Date.now() + timeoutMs;
  let lastState;
  let readError;
  do {
    try {
      lastState = await inspectRenderedConfirmation(tab, expected);
      readError = undefined;
      if (
        lastState?.present &&
        lastState?.visible &&
        lastState?.hitTarget &&
        Number.isFinite(lastState?.x) &&
        Number.isFinite(lastState?.y)
      ) {
        return { state: lastState };
      }
    } catch (error) {
      readError = error;
    }
    if (Date.now() < deadline) await wait(pollIntervalMs);
  } while (Date.now() < deadline);
  return { state: lastState, readError };
}

function validateCommonInput({ tab, expectedHref, expectedConfirmText }) {
  if (
    !tab ||
    typeof tab !== "object" ||
    !tab?.cua?.click ||
    !tab?.playwright?.evaluate ||
    !expectedHref ||
    !expectedConfirmText
  ) {
    throw new ConfirmingClickError(
      "invalid_input",
      "Browserのタブ、対象リンク、確認文が必要です。",
    );
  }
}

/**
 * ZAWAZAWAの削除リンクから、画面内に描画される確認UIを開く。
 * この段階では状態変更を送信しないため、一意な対象を再照合できる範囲で再クリックできる。
 */
async function openRenderedConfirmationImpl({
  tab,
  trigger,
  expectedHref,
  expectedConfirmText,
  expectedYesText = "はい",
  expectedNoText = "いいえ",
  confirmationTimeoutMs = DEFAULT_CONFIRMATION_TIMEOUT_MS,
  clickTimeoutMs = DEFAULT_CLICK_TIMEOUT_MS,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  maxTriggerAttempts = DEFAULT_TRIGGER_ATTEMPTS,
}) {
  validateCommonInput({ tab, expectedHref, expectedConfirmText });
  if (!trigger?.getAttribute) {
    throw new ConfirmingClickError(
      "invalid_input",
      "一意な削除リンクが必要です。",
    );
  }
  if (!Number.isInteger(maxTriggerAttempts) || maxTriggerAttempts < 1 || maxTriggerAttempts > 3) {
    throw new ConfirmingClickError(
      "invalid_input",
      "確認UIを開く試行回数は1から3で指定してください。",
    );
  }

  const actualHref = await trigger.getAttribute("href");
  if (actualHref !== expectedHref) {
    throw new ConfirmingClickError(
      "precheck_mismatch",
      "削除リンクの対象が承認済みの期待値と一致しません。",
    );
  }

  const expected = {
    expectedHref,
    expectedConfirmText,
    expectedYesText,
    expectedNoText,
  };
  const alreadyOpen = await waitForRenderedConfirmation(tab, expected, 0, pollIntervalMs);
  if (alreadyOpen.readError) {
    throw new ConfirmingClickError(
      "confirmation_precheck_failed",
      "既存の確認UIを読み取れなかったため、確認UIを開く操作を開始せず停止しました。対象を再読込してからやり直してください。",
      { actionMayHaveBeenDispatched: false },
    );
  }
  if (alreadyOpen.state?.candidateCount > 0) {
    throw new ConfirmingClickError(
      "confirmation_preexisting",
      "確認UIがこの操作で開かれたものか確認できないため停止しました。対象を再読込してから確認UIを開き直してください。",
      { actionMayHaveBeenDispatched: false },
    );
  }

  let lastReadError;
  for (let attempt = 1; attempt <= maxTriggerAttempts; attempt += 1) {
    let clickPoint;
    try {
      clickPoint = await inspectTrigger(tab, expectedHref);
    } catch {
      throw new ConfirmingClickError(
        "trigger_position_unavailable",
        "削除リンクの表示位置を確認できなかったため停止しました。",
      );
    }
    if (
      clickPoint?.matchCount !== 1 ||
      !clickPoint?.visible ||
      !clickPoint?.hitTarget ||
      !Number.isFinite(clickPoint?.x) ||
      !Number.isFinite(clickPoint?.y)
    ) {
      throw new ConfirmingClickError(
        "trigger_not_clickable",
        "削除リンクが表示領域内の一意なクリック可能要素ではないため停止しました。",
      );
    }

    await clickWithTimeout(tab, clickPoint, clickTimeoutMs);
    const observed = await waitForRenderedConfirmation(
      tab,
      expected,
      confirmationTimeoutMs,
      pollIntervalMs,
    );
    lastReadError = observed.readError;
    if (observed.state?.present && observed.state?.visible && observed.state?.hitTarget) {
      return {
        href: actualHref,
        triggerClickCount: attempt,
        actionHref: observed.state.actionHref,
      };
    }
  }

  throw new ConfirmingClickError(
    "confirmation_not_observed",
    lastReadError
      ? "削除リンクを開いた後の確認UIを安定して読み取れませんでした。対象を再読込してから確認UIの表示をやり直せます。"
      : "削除リンクを開いても確認UIが表示されませんでした。対象を再読込してから確認UIの表示をやり直せます。",
    { actionMayHaveBeenDispatched: false },
  );
}

export async function openRenderedConfirmation(args) {
  const { tab, expectedHref, expectedConfirmText } = args || {};
  validateCommonInput({ tab, expectedHref, expectedConfirmText });
  const existing = confirmationSessions.get(tab);
  if (existing?.status === "opening" || existing?.status === "accepting") {
    throw new ConfirmingClickError(
      "confirmation_provenance_conflict",
      "同じブラウザタブで確認操作が並行しているため停止しました。対象を再読込してからやり直してください。",
      { actionMayHaveBeenDispatched: false },
    );
  }
  // Reopening invalidates any unconsumed prior capability before checking the
  // page again.  A pre-existing dialog is rejected by the implementation.
  const session = { status: "opening" };
  confirmationSessions.set(tab, session);
  try {
    const result = await openRenderedConfirmationImpl(args);
    if (confirmationSessions.get(tab) !== session) {
      throw new ConfirmingClickError(
        "confirmation_provenance_conflict",
        "確認UIの所有権が別の操作で無効化されたため停止しました。対象を再読込してからやり直してください。",
        { actionMayHaveBeenDispatched: false },
      );
    }
    session.status = "ready";
    session.actionHref = result.actionHref;
    session.expectedHref = args.expectedHref;
    session.expectedConfirmText = args.expectedConfirmText;
    session.expectedYesText = args.expectedYesText ?? "はい";
    session.expectedNoText = args.expectedNoText ?? "いいえ";
    const { actionHref: _actionHref, ...publicResult } = result;
    return publicResult;
  } catch (error) {
    if (confirmationSessions.get(tab) === session) confirmationSessions.delete(tab);
    throw error;
  }
}

/**
 * 描画済み確認UIの「はい」を一度だけ押す。呼び出し側は直前に`dispatching`を記録する。
 * このクリックから状態変更が送信され得るため、失敗時も自動再試行しない。
 */
export async function acceptRenderedConfirmation({
  tab,
  expectedHref,
  expectedConfirmText,
  expectedYesText = "はい",
  expectedNoText = "いいえ",
  clickTimeoutMs = DEFAULT_CLICK_TIMEOUT_MS,
}) {
  validateCommonInput({ tab, expectedHref, expectedConfirmText });
  const session = confirmationSessions.get(tab);
  if (!session || session.status !== "ready") {
    if (session?.status === "opening") confirmationSessions.delete(tab);
    throw new ConfirmingClickError(
      session ? "confirmation_provenance_conflict" : "confirmation_provenance_missing",
      session
        ? "同じブラウザタブで確認操作が並行しているため停止しました。対象を再読込してからやり直してください。"
        : "この確認UIは同じヘルパー呼び出しで開かれていないため停止しました。",
      { actionMayHaveBeenDispatched: false },
    );
  }
  // Reserve the session before any read or click.  A second open/accept call
  // sees this state and fails closed while the first call is still active.
  session.status = "accepting";
  const provenance = session;
  const consumeSession = () => {
    if (confirmationSessions.get(tab) === session) confirmationSessions.delete(tab);
  };
  if (
    provenance.expectedHref !== expectedHref ||
    provenance.expectedConfirmText !== expectedConfirmText ||
    provenance.expectedYesText !== expectedYesText ||
    provenance.expectedNoText !== expectedNoText
  ) {
    consumeSession();
    throw new ConfirmingClickError(
      "confirmation_provenance_mismatch",
      "確認UIの承認済み対象がこの操作の期待値と一致しないため停止しました。",
      { actionMayHaveBeenDispatched: false },
    );
  }
  let confirmation;
  try {
    confirmation = await inspectRenderedConfirmation(tab, {
      expectedHref,
      expectedConfirmText,
      expectedYesText,
      expectedNoText,
    });
  } catch {
    consumeSession();
    throw new ConfirmingClickError(
      "confirmation_precheck_failed",
      "確認UIを読み取れなかったため「はい」を押さず停止しました。",
    );
  }
  if (
    !confirmation?.present ||
    confirmation?.matchCount !== 1 ||
    confirmation?.candidateCount !== 1 ||
    confirmation?.actionHref !== provenance.actionHref ||
    !confirmation?.visible ||
    !confirmation?.hitTarget ||
    !Number.isFinite(confirmation?.x) ||
    !Number.isFinite(confirmation?.y)
  ) {
    consumeSession();
    throw new ConfirmingClickError(
      "confirmation_precheck_mismatch",
      "対象の確認UIと一意な「はい」ボタンを照合できなかったため停止しました。",
    );
  }

  const clickResult = await clickWithTimeout(tab, confirmation, clickTimeoutMs);
  if (!clickResult.completed) {
    consumeSession();
    throw new ConfirmingClickError(
      "confirmation_click_uncertain",
      "「はい」のクリック結果を確定できませんでした。ライブ状態を読み戻し、同じ操作を再試行しないでください。",
      { actionMayHaveBeenDispatched: true },
    );
  }
  consumeSession();
  return {
    href: expectedHref,
    confirmationAccepted: true,
    confirmationClickCount: 1,
    clickPoint: { x: confirmation.x, y: confirmation.y },
  };
}
