import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import test from "node:test";

process.env.ZAWAZAWA_PREVIEW_NO_LISTEN = "1";
const { MAX_BODY_BYTES, previewServer } = await import("../scripts/preview-server.mjs");
let address;

test.before(async () => {
  address = await new Promise((resolve, reject) => {
    previewServer.once("error", reject);
    previewServer.listen(0, "localhost", () => resolve(previewServer.address()));
  });
});

test.after(async () => {
  if (!previewServer.listening) return;
  await new Promise((resolve, reject) => previewServer.close((error) => (error ? reject(error) : resolve())));
});

function post(chunks, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: "localhost",
        port: address.port,
        path: "/preview-tools/not-a-tool",
        method: "POST",
        headers,
      },
      (response) => {
        const body = [];
        response.on("data", (chunk) => body.push(chunk));
        response.on("end", () =>
          resolve({
            statusCode: response.statusCode,
            body: Buffer.concat(body).toString("utf8"),
          }),
        );
      },
    );
    request.on("error", reject);
    for (const chunk of chunks) request.write(chunk);
    request.end();
  });
}

function get(path) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      { hostname: "localhost", port: address.port, path, method: "GET" },
      (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode));
      },
    );
    request.on("error", reject);
    request.end();
  });
}

function jsonBodyWithByteLength(length) {
  const prefix = Buffer.from('{"padding":"', "utf8");
  const suffix = Buffer.from('"}', "utf8");
  return Buffer.concat([prefix, Buffer.alloc(length - prefix.length - suffix.length, 0x61), suffix]);
}

test("上限ちょうどのJSON本文は読み取り、413にはしない", async () => {
  const body = jsonBodyWithByteLength(MAX_BODY_BYTES);
  const response = await post([body], {
    "content-type": "application/json",
    "content-length": String(body.length),
  });

  assert.equal(body.length, MAX_BODY_BYTES);
  assert.equal(response.statusCode, 400);
  assert.match(response.body, /未対応のツール/u);
});

test("Content-Lengthが上限を超える本文は読み込まず413を返す", async () => {
  const response = await post([Buffer.from("{}")], {
    "content-type": "application/json",
    "content-length": String(MAX_BODY_BYTES + 1),
  });

  assert.equal(response.statusCode, 413);
  assert.match(response.body, /大きすぎます/u);
});

test("chunked UTF-8本文は受信バイト数で上限を判定する", async () => {
  const first = Buffer.alloc(MAX_BODY_BYTES - 1, 0x61);
  const second = Buffer.from("あ", "utf8");
  const response = await post([first, second], { "content-type": "application/json" });

  assert.equal(first.length + second.length, MAX_BODY_BYTES + 2);
  assert.equal(response.statusCode, 413);
  assert.match(response.body, /大きすぎます/u);
});

test("上限超過後もプレビューサーバーは次の要求へ応答する", async () => {
  const response = await post([Buffer.alloc(MAX_BODY_BYTES + 1, 0x61)], {
    "content-type": "application/json",
  });
  assert.equal(response.statusCode, 413);
  assert.equal(await get("/"), 200);
});
