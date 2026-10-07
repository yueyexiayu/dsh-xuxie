import test from "node:test";
import assert from "node:assert/strict";
import { installEmptyResponseGuard } from "../lib/empty-response.js";
import { hostModules } from "./host-runtime.mjs";

const { llm } = await hostModules();

function response(content = [], reason = { kind: "stop" }) {
  return [
    ...content.flatMap((block, index) => [
      { type: "block-start", index, blockType: block.type },
      { type: "block-end", index, block },
    ]),
    { type: "usage", usage: { inputTokens: 2, outputTokens: 0, totalTokens: 2 } },
    { type: "finish", reason, replayState: { response: "successful-provider-cursor" } },
  ];
}

async function guard(chunks, { accepted = true, agent = {}, missingAgent = false, ...options } = {}) {
  let hook;
  let selection;
  let imports = 0;
  await installEmptyResponseGuard({
    loader: { async import(name) {
      assert.equal(name, "@deepseek-ai/dsh-llm");
      imports += 1;
      return llm;
    } },
    agents: { get(id) { assert.equal(id, "session"); return missingAgent ? undefined : agent; } },
    on(name, listener) { assert.equal(name, "llm/stream"); hook = listener; },
  }, (candidate, route) => { selection = { candidate, route }; return accepted; });
  const request = { sessionId: "session", provider: "test", model: "fixture", ...options };
  const result = [];
  for await (const chunk of hook(request, async function* () { yield* chunks; })) result.push(chunk);
  assert.equal(imports, 1);
  return { result, selection };
}

test("blank text and reasoning become EMPTY_RESPONSE without mutating chunks or losing usage", async () => {
  for (const content of [[], [{ type: "text", text: "" }], [
    { type: "reasoning", text: " \n" }, { type: "text", text: "\t" },
  ]]) {
    const chunks = response(content);
    const { result } = await guard(chunks);
    assert.deepEqual(result.slice(0, -1), chunks.slice(0, -1));
    assert.deepEqual(result.at(-1).reason, {
      kind: "error", failure: { code: "EMPTY_RESPONSE", message: 'model "fixture" returned a completed response with no content' },
    });
    assert.equal("replayState" in result.at(-1), false);
    assert.equal(chunks.at(-1).reason.kind, "stop");
    assert.equal(chunks.at(-1).replayState.response, "successful-provider-cursor");
  }
});

test("nonempty reasoning, text, tools, attachments, and future blocks retain the original finish", async () => {
  for (const block of [
    { type: "reasoning", text: "thinking" }, { type: "text", text: "answer" },
    { type: "tool-call", id: "call", name: "read", arguments: "{}" },
    { type: "image", image: { kind: "reference", ref: "image" } },
    { type: "file", ref: "file" }, { type: "future-block", payload: true },
  ]) {
    const chunks = response([block]);
    assert.deepEqual((await guard(chunks)).result, chunks, block.type);
  }
});

test("official assembly handles delta-only streams and authoritative block-end values", async () => {
  const finish = { type: "finish", reason: { kind: "stop" } };
  const textDelta = { type: "text-delta", index: 0, text: "answer" };
  const deltaOnly = [textDelta, finish];
  assert.deepEqual((await guard(deltaOnly)).result, deltaOnly);
  const blank = [textDelta, { type: "block-end", index: 0, block: { type: "text", text: "" } }, finish];
  assert.equal((await guard(blank)).result.at(-1).reason.failure.code, "EMPTY_RESPONSE");
});

test("failure, cancellation, tool-calls, truncation, and an aborted signal retain their finish", async () => {
  for (const kind of ["error", "aborted", "tool-calls", "max-tokens"]) {
    const chunks = response([], { kind, failure: { code: "ORIGINAL", message: "original" } });
    assert.deepEqual((await guard(chunks)).result, chunks, kind);
  }
  const controller = new AbortController();
  controller.abort();
  const chunks = response();
  assert.deepEqual((await guard(chunks, { signal: controller.signal })).result, chunks);
});

test("only accepted conversational agents are guarded and route filters receive the actual request", async () => {
  const chunks = response();
  const agent = {};
  const normal = await guard(chunks, { agent });
  assert.equal(normal.selection.candidate, agent);
  assert.deepEqual(normal.selection.route, { provider: "test", model: "fixture" });
  for (const options of [
    { accepted: false }, { sessionId: undefined }, { missingAgent: true },
    { purpose: "session-title" }, { purpose: "compaction" },
  ]) {
    const { result } = await guard(chunks, options);
    assert.deepEqual(result, chunks);
  }
});

test("stream exceptions remain visible and close the wrapped iterator", async () => {
  let hook;
  await installEmptyResponseGuard({
    loader: { import: async () => llm }, agents: { get: () => ({}) },
    on(_name, listener) { hook = listener; },
  }, () => true);
  let closed = false;
  const stream = hook({ sessionId: "session", model: "fixture" }, async function* () {
    try { yield { type: "text-delta", index: 0, text: "prefix" }; throw new Error("provider failed"); }
    finally { closed = true; }
  });
  await assert.rejects(async () => { for await (const _chunk of stream) {} }, /provider failed/);
  assert.equal(closed, true);
});
