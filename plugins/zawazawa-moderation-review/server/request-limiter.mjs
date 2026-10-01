/** 同一サーバープロセスからZAWAZAWAへ出す通信の共有上限。 */
export const MAX_CONCURRENT_ZAWAZAWA_REQUESTS = 3;

/**
 * 固定待ち時間を足さず、空いた枠へ待機中の処理をFIFOで渡す小さなセマフォ。
 * 呼び出し側は実通信のleaf境界だけを`run`で包み、複数通信を行う上位処理では包まない。
 */
export function createRequestLimiter(maxConcurrent = MAX_CONCURRENT_ZAWAZAWA_REQUESTS) {
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
    throw new TypeError("通信の並行数上限は1以上の整数で指定してください。");
  }

  let active = 0;
  const waiting = [];

  async function acquire() {
    if (active < maxConcurrent) {
      active += 1;
      return;
    }
    // 解放側が使用中の1枠を直接引き渡すため、再開後にactiveを増やさない。
    await new Promise((resolve) => waiting.push(resolve));
  }

  function release() {
    const next = waiting.shift();
    if (next) {
      next();
      return;
    }
    active -= 1;
  }

  return Object.freeze({
    async run(operation) {
      if (typeof operation !== "function") {
        throw new TypeError("通信処理は関数で指定してください。");
      }
      await acquire();
      try {
        return await operation();
      } finally {
        release();
      }
    },
  });
}
