const serverUrlSuffix = "/server/server.mjs";
// サーバーがZAWAZAWAへ届く経路。管理画面と公開ページの両方を差し替えないと、
// テストが実サイトへ要求を出す。
const mocks = new Map([
  [
    "/server/zawazawa-connector.mjs",
    new URL("./mock-zawazawa-connector.mjs", import.meta.url).href,
  ],
  ["/server/public-reader.mjs", new URL("./mock-public-reader.mjs", import.meta.url).href],
]);

export async function resolve(specifier, context, nextResolve) {
  const resolved = await nextResolve(specifier, context);
  if (!context.parentURL?.endsWith(serverUrlSuffix)) return resolved;
  for (const [suffix, url] of mocks) {
    if (resolved.url.endsWith(suffix)) return { url, shortCircuit: true };
  }
  return resolved;
}
