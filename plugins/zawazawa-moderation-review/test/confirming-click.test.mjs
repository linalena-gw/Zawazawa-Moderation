import assert from "node:assert/strict";
import test from "node:test";
import {
  acceptRenderedConfirmation,
  ConfirmingClickError,
  openRenderedConfirmation,
} from "../skills/zawazawa-moderation/scripts/confirming-click.mjs";

const EXPECTED_HREF = "/m/g/comment/345/99215/delete";
const OTHER_HREF = "/m/g/comment/345/other/delete";
const EXPECTED_CONFIRM = "本当によろしいですか";
const BASE_URI = "https://example.test/moderation/";
const TRIGGER_RECT = { left: 80, top: 200, width: 80, height: 80 };
const YES_RECT = { left: 320, top: 400, width: 80, height: 80 };
const NO_RECT = { left: 420, top: 400, width: 80, height: 80 };

function triggerWith(href = EXPECTED_HREF) {
  return {
    async getAttribute(name) {
      return name === "href" ? href : null;
    },
  };
}

function element({
  tagName,
  textContent = "",
  value = "",
  attributes = {},
  rect,
  form = null,
  closest = () => null,
}) {
  const result = {
    tagName,
    textContent,
    value,
    form,
    getAttribute(name) {
      return Object.hasOwn(attributes, name) ? attributes[name] : null;
    },
    getBoundingClientRect() {
      return rect;
    },
    contains(target) {
      return target === result;
    },
    closest,
  };
  return result;
}

function confirmationScope({
  binding = "anchor",
  actionHref = EXPECTED_HREF,
  formAction = actionHref,
  submitterAction,
  withDialogScope = true,
} = {}) {
  const scope = {
    querySelectorAll() {
      return [yes, no];
    },
  };
  const message = element({
    tagName: "P",
    textContent: EXPECTED_CONFIRM,
    rect: { left: 20, top: 20, width: 260, height: 30 },
    closest: () => (withDialogScope ? scope : null),
  });
  const no = element({
    tagName: "BUTTON",
    textContent: "いいえ",
    rect: NO_RECT,
    attributes: { type: "button" },
    closest: () => scope,
  });
  let yes;
  if (binding === "anchor") {
    yes = element({
      tagName: "A",
      textContent: "はい",
      rect: YES_RECT,
      attributes: { href: actionHref },
      closest: () => scope,
    });
  } else if (binding === "form") {
    const form = {
      action: formAction,
      getAttribute(name) {
        return name === "action" ? formAction : null;
      },
    };
    yes = element({
      tagName: "BUTTON",
      textContent: "はい",
      rect: YES_RECT,
      attributes: {
        type: "submit",
        ...(submitterAction === undefined ? {} : { formaction: submitterAction }),
      },
      form,
      closest: () => scope,
    });
  } else if (binding === "opaque") {
    yes = element({
      tagName: "BUTTON",
      textContent: "はい",
      rect: YES_RECT,
      attributes: { type: "button", "data-action": actionHref },
      closest: () => scope,
    });
  } else if (binding === "unbound-submit") {
    yes = element({
      tagName: "BUTTON",
      textContent: "はい",
      rect: YES_RECT,
      attributes: { type: "submit" },
      closest: () => scope,
    });
  } else {
    throw new Error(`unknown binding: ${binding}`);
  }
  return { message, scope, yes, no };
}

function tabWithDom({
  confirmations = () => [],
  triggerHitTarget = true,
  onConfirmationClick = async () => {},
  onConfirmationInspect = () => {},
  initiallyOpened = false,
} = {}) {
  let opened = initiallyOpened;
  let triggerClickCount = 0;
  let confirmationClickCount = 0;
  let confirmationInspectionCount = 0;
  const trigger = element({
    tagName: "A",
    attributes: { href: EXPECTED_HREF },
    rect: TRIGGER_RECT,
  });
  const overlay = {};
  const state = {
    get opened() {
      return opened;
    },
    get triggerClickCount() {
      return triggerClickCount;
    },
    get confirmationClickCount() {
      return confirmationClickCount;
    },
    get confirmationInspectionCount() {
      return confirmationInspectionCount;
    },
  };
  const tab = {
    cua: {
      async click({ x }) {
        if (x === 120) {
          triggerClickCount += 1;
          opened = true;
          return;
        }
        confirmationClickCount += 1;
        await onConfirmationClick({ state });
      },
    },
    playwright: {
      async evaluate(callback, input) {
        const currentConfirmations = opened
          ? confirmations({
              triggerClickCount,
              confirmationClickCount,
              confirmationInspectionCount,
            })
          : [];
        if (input.kind === "confirmation") {
          confirmationInspectionCount += 1;
          onConfirmationInspect({ confirmationInspectionCount, state });
        }
        const messages = currentConfirmations.map(({ message }) => message);
        const previousDocument = globalThis.document;
        const previousWindow = globalThis.window;
        try {
          globalThis.document = {
            baseURI: BASE_URI,
            querySelectorAll(selector) {
              if (selector === "a[href]") return [trigger];
              if (selector === "h1,h2,h3,h4,h5,p,div,span") return messages;
              return [];
            },
            elementFromPoint() {
              if (input.kind === "trigger") return triggerHitTarget ? trigger : overlay;
              return currentConfirmations[0]?.yes || overlay;
            },
          };
          globalThis.window = {
            innerWidth: 1280,
            innerHeight: 720,
            location: { href: BASE_URI },
            getComputedStyle: () => ({ visibility: "visible", display: "block" }),
          };
          return callback(input);
        } finally {
          globalThis.document = previousDocument;
          globalThis.window = previousWindow;
        }
      },
    },
  };
  return { tab, state };
}

function expectedConfirmation(options) {
  return [confirmationScope(options)];
}

test("削除リンクを一度押して描画確認UIを開く", async () => {
  const { tab, state } = tabWithDom({ confirmations: () => expectedConfirmation() });

  const result = await openRenderedConfirmation({
    tab,
    trigger: triggerWith(),
    expectedHref: EXPECTED_HREF,
    expectedConfirmText: EXPECTED_CONFIRM,
    confirmationTimeoutMs: 1,
    pollIntervalMs: 1,
  });

  assert.equal(state.triggerClickCount, 1);
  assert.equal(result.triggerClickCount, 1);
  assert.equal(result.href, EXPECTED_HREF);
});

test("確認UIが未表示なら非変更の削除リンクだけを再クリックする", async () => {
  const { tab, state } = tabWithDom({
    confirmations: ({ triggerClickCount }) =>
      triggerClickCount >= 2 ? expectedConfirmation() : [],
  });

  const result = await openRenderedConfirmation({
    tab,
    trigger: triggerWith(),
    expectedHref: EXPECTED_HREF,
    expectedConfirmText: EXPECTED_CONFIRM,
    confirmationTimeoutMs: 0,
    pollIntervalMs: 1,
  });

  assert.equal(state.triggerClickCount, 2);
  assert.equal(result.triggerClickCount, 2);
});

test("既に開いている確認UIは今回の削除リンクで開いたものとして扱わない", async () => {
  const { tab, state } = tabWithDom({
    confirmations: () => expectedConfirmation(),
    initiallyOpened: true,
  });

  await assert.rejects(
    openRenderedConfirmation({
      tab,
      trigger: triggerWith(),
      expectedHref: EXPECTED_HREF,
      expectedConfirmText: EXPECTED_CONFIRM,
    }),
    (error) =>
      error instanceof ConfirmingClickError && error.code === "confirmation_preexisting",
  );
  assert.equal(state.triggerClickCount, 0);
});

test("既存確認UIの初回読み取り失敗は開く操作を開始せずprovenanceも残さない", async () => {
  const { tab, state } = tabWithDom({
    confirmations: () => expectedConfirmation(),
    initiallyOpened: true,
    onConfirmationInspect: ({ confirmationInspectionCount }) => {
      if (confirmationInspectionCount === 1) {
        throw new Error("simulated initial confirmation inspection failure");
      }
    },
  });

  await assert.rejects(
    openRenderedConfirmation({
      tab,
      trigger: triggerWith(),
      expectedHref: EXPECTED_HREF,
      expectedConfirmText: EXPECTED_CONFIRM,
    }),
    (error) =>
      error instanceof ConfirmingClickError &&
      error.code === "confirmation_precheck_failed" &&
      error.actionMayHaveBeenDispatched === false,
  );
  assert.equal(state.triggerClickCount, 0);
  assert.equal(state.confirmationClickCount, 0);
  await assert.rejects(
    acceptRenderedConfirmation({
      tab,
      expectedHref: EXPECTED_HREF,
      expectedConfirmText: EXPECTED_CONFIRM,
    }),
    (error) => error instanceof ConfirmingClickError && error.code === "confirmation_provenance_missing",
  );
});

test("削除リンクの対象が違えば確認UIを開く前に停止する", async () => {
  const { tab, state } = tabWithDom();

  await assert.rejects(
    openRenderedConfirmation({
      tab,
      trigger: triggerWith(OTHER_HREF),
      expectedHref: EXPECTED_HREF,
      expectedConfirmText: EXPECTED_CONFIRM,
    }),
    (error) =>
      error instanceof ConfirmingClickError && error.code === "precheck_mismatch",
  );
  assert.equal(state.triggerClickCount, 0);
});

test("削除リンクが最前面でなければ確認UIを開く前に停止する", async () => {
  const { tab, state } = tabWithDom({ triggerHitTarget: false });

  await assert.rejects(
    openRenderedConfirmation({
      tab,
      trigger: triggerWith(),
      expectedHref: EXPECTED_HREF,
      expectedConfirmText: EXPECTED_CONFIRM,
    }),
    (error) =>
      error instanceof ConfirmingClickError && error.code === "trigger_not_clickable",
  );
  assert.equal(state.triggerClickCount, 0);
});

test("確認UIを開けない失敗は状態変更未送信として返す", async () => {
  const { tab, state } = tabWithDom();

  await assert.rejects(
    openRenderedConfirmation({
      tab,
      trigger: triggerWith(),
      expectedHref: EXPECTED_HREF,
      expectedConfirmText: EXPECTED_CONFIRM,
      confirmationTimeoutMs: 0,
      maxTriggerAttempts: 2,
    }),
    (error) =>
      error instanceof ConfirmingClickError &&
      error.code === "confirmation_not_observed" &&
      error.actionMayHaveBeenDispatched === false,
  );
  assert.equal(state.triggerClickCount, 2);
});

test("描画確認UIの「はい」を一度だけ押す", async () => {
  const { tab, state } = tabWithDom({ confirmations: () => expectedConfirmation() });
  await openRenderedConfirmation({
    tab,
    trigger: triggerWith(),
    expectedHref: EXPECTED_HREF,
    expectedConfirmText: EXPECTED_CONFIRM,
  });

  const result = await acceptRenderedConfirmation({
    tab,
    expectedHref: EXPECTED_HREF,
    expectedConfirmText: EXPECTED_CONFIRM,
  });

  assert.equal(state.confirmationClickCount, 1);
  assert.equal(result.confirmationAccepted, true);
  assert.equal(result.confirmationClickCount, 1);
});

test("送信ボタンのformactionとbase-relative URLを対象へ束縛する", async () => {
  const { tab, state } = tabWithDom({
    confirmations: () =>
      expectedConfirmation({
        binding: "form",
        formAction: OTHER_HREF,
        submitterAction: EXPECTED_HREF,
      }),
  });
  await openRenderedConfirmation({
    tab,
    trigger: triggerWith(),
    expectedHref: EXPECTED_HREF,
    expectedConfirmText: EXPECTED_CONFIRM,
  });

  await acceptRenderedConfirmation({
    tab,
    expectedHref: EXPECTED_HREF,
    expectedConfirmText: EXPECTED_CONFIRM,
  });
  assert.equal(state.confirmationClickCount, 1);
});

test("誤ったaction URLの確認UIは開いたことにせず停止する", async () => {
  const { tab, state } = tabWithDom({
    confirmations: () => expectedConfirmation({ actionHref: OTHER_HREF }),
  });

  await assert.rejects(
    openRenderedConfirmation({
      tab,
      trigger: triggerWith(),
      expectedHref: EXPECTED_HREF,
      expectedConfirmText: EXPECTED_CONFIRM,
      confirmationTimeoutMs: 0,
    }),
    (error) => error instanceof ConfirmingClickError && error.code === "confirmation_not_observed",
  );
  assert.equal(state.confirmationClickCount, 0);
});

test("同じ確認文を持つ複数ダイアログはactionが一致しても選ばない", async () => {
  const { tab, state } = tabWithDom({
    confirmations: () => [
      confirmationScope({ actionHref: EXPECTED_HREF }),
      confirmationScope({ actionHref: OTHER_HREF }),
    ],
  });

  await assert.rejects(
    openRenderedConfirmation({
      tab,
      trigger: triggerWith(),
      expectedHref: EXPECTED_HREF,
      expectedConfirmText: EXPECTED_CONFIRM,
      confirmationTimeoutMs: 0,
    }),
    (error) => error instanceof ConfirmingClickError && error.code === "confirmation_not_observed",
  );
  assert.equal(state.confirmationClickCount, 0);
});

test("opaqueなボタンや確認領域を特定できない表示は拒否する", async () => {
  for (const options of [{ binding: "opaque" }, { binding: "unbound-submit" }, { withDialogScope: false }]) {
    const { tab, state } = tabWithDom({ confirmations: () => expectedConfirmation(options) });
    await assert.rejects(
      openRenderedConfirmation({
        tab,
        trigger: triggerWith(),
        expectedHref: EXPECTED_HREF,
        expectedConfirmText: EXPECTED_CONFIRM,
        confirmationTimeoutMs: 0,
      }),
      (error) => error instanceof ConfirmingClickError && error.code === "confirmation_not_observed",
    );
    assert.equal(state.confirmationClickCount, 0);
  }
});

test("acceptは同じタブで直前に開いた確認UIだけを一度使える", async () => {
  const standalone = tabWithDom({ confirmations: () => expectedConfirmation() });
  await assert.rejects(
    acceptRenderedConfirmation({
      tab: standalone.tab,
      expectedHref: EXPECTED_HREF,
      expectedConfirmText: EXPECTED_CONFIRM,
    }),
    (error) => error instanceof ConfirmingClickError && error.code === "confirmation_provenance_missing",
  );

  const { tab, state } = tabWithDom({ confirmations: () => expectedConfirmation() });
  await openRenderedConfirmation({
    tab,
    trigger: triggerWith(),
    expectedHref: EXPECTED_HREF,
    expectedConfirmText: EXPECTED_CONFIRM,
  });
  await acceptRenderedConfirmation({
    tab,
    expectedHref: EXPECTED_HREF,
    expectedConfirmText: EXPECTED_CONFIRM,
  });
  await assert.rejects(
    acceptRenderedConfirmation({
      tab,
      expectedHref: EXPECTED_HREF,
      expectedConfirmText: EXPECTED_CONFIRM,
    }),
    (error) => error instanceof ConfirmingClickError && error.code === "confirmation_provenance_missing",
  );
  assert.equal(state.confirmationClickCount, 1);
});

test("受け入れ直前にaction URLが変わった確認UIは押さない", async () => {
  const { tab, state } = tabWithDom({
    confirmations: ({ confirmationInspectionCount }) =>
      expectedConfirmation({
        actionHref: confirmationInspectionCount >= 2 ? OTHER_HREF : EXPECTED_HREF,
      }),
  });
  await openRenderedConfirmation({
    tab,
    trigger: triggerWith(),
    expectedHref: EXPECTED_HREF,
    expectedConfirmText: EXPECTED_CONFIRM,
  });

  await assert.rejects(
    acceptRenderedConfirmation({
      tab,
      expectedHref: EXPECTED_HREF,
      expectedConfirmText: EXPECTED_CONFIRM,
    }),
    (error) => error instanceof ConfirmingClickError && error.code === "confirmation_precheck_mismatch",
  );
  assert.equal(state.confirmationClickCount, 0);
});

test("期待値が違うaccept試行はprovenanceを消費する", async () => {
  const { tab, state } = tabWithDom({ confirmations: () => expectedConfirmation() });
  await openRenderedConfirmation({
    tab,
    trigger: triggerWith(),
    expectedHref: EXPECTED_HREF,
    expectedConfirmText: EXPECTED_CONFIRM,
  });

  await assert.rejects(
    acceptRenderedConfirmation({
      tab,
      expectedHref: OTHER_HREF,
      expectedConfirmText: EXPECTED_CONFIRM,
    }),
    (error) => error instanceof ConfirmingClickError && error.code === "confirmation_provenance_mismatch",
  );
  await assert.rejects(
    acceptRenderedConfirmation({
      tab,
      expectedHref: EXPECTED_HREF,
      expectedConfirmText: EXPECTED_CONFIRM,
    }),
    (error) => error instanceof ConfirmingClickError && error.code === "confirmation_provenance_missing",
  );
  assert.equal(state.confirmationClickCount, 0);
});

test("「はい」のクリック失敗は送信可能性ありとして再試行を拒む", async () => {
  const { tab, state } = tabWithDom({
    confirmations: () => expectedConfirmation(),
    onConfirmationClick: async () => {
      throw new Error("temporary transport failure");
    },
  });
  await openRenderedConfirmation({
    tab,
    trigger: triggerWith(),
    expectedHref: EXPECTED_HREF,
    expectedConfirmText: EXPECTED_CONFIRM,
  });

  await assert.rejects(
    acceptRenderedConfirmation({
      tab,
      expectedHref: EXPECTED_HREF,
      expectedConfirmText: EXPECTED_CONFIRM,
    }),
    (error) =>
      error instanceof ConfirmingClickError &&
      error.code === "confirmation_click_uncertain" &&
      error.actionMayHaveBeenDispatched === true,
  );
  assert.equal(state.confirmationClickCount, 1);
});

test("「はい」のクリックがタイムアウトしてもprovenanceを再利用しない", async () => {
  const { tab, state } = tabWithDom({
    confirmations: () => expectedConfirmation(),
    onConfirmationClick: () => new Promise(() => {}),
  });
  await openRenderedConfirmation({
    tab,
    trigger: triggerWith(),
    expectedHref: EXPECTED_HREF,
    expectedConfirmText: EXPECTED_CONFIRM,
  });

  await assert.rejects(
    acceptRenderedConfirmation({
      tab,
      expectedHref: EXPECTED_HREF,
      expectedConfirmText: EXPECTED_CONFIRM,
      clickTimeoutMs: 1,
    }),
    (error) =>
      error instanceof ConfirmingClickError &&
      error.code === "confirmation_click_uncertain" &&
      error.actionMayHaveBeenDispatched === true,
  );
  assert.equal(state.confirmationClickCount, 1);
});
