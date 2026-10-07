import test from "node:test";
import assert from "node:assert/strict";
import {
  PLUGIN_ID, SILENT_MARKER, STEER_TEXT, acceptsAgent, createTurnState,
  isReasoningOnlyContent, reduceTurnState, resolveConfig, steeringMessage, turnStateSchema,
} from "../lib/detect.js";

function assistant(content, { finish = "stop", turn = 1, interrupted = false, stream } = {}) {
  return { type: "assistant/message", data: {
    turn, interrupted, message: { source: { kind: "model", provider: "xai", model: "grok" }, content },
    stream: stream ?? [{ type: "chunk", chunk: { type: "finish", reason: { kind: finish } } }],
  } };
}
const reasoning = [{ type: "reasoning", text: "consider the answer" }];

test("only nonempty reasoning without visible blocks is classified as reasoning-only", () => {
  assert.equal(isReasoningOnlyContent(reasoning), true);
  assert.equal(isReasoningOnlyContent([...reasoning, { type: "text", text: "  " }]), true);
  for (const content of [[], [{ type: "reasoning", text: " " }],
    [...reasoning, { type: "text", text: "answer" }],
    ...["tool-call", "image", "file", "audio", "video", "future-block"].map((type) => [...reasoning, { type }])]) {
    assert.equal(isReasoningOnlyContent(content), false);
  }
});

test("normal stop is required; failures and incomplete streams cannot reuse an earlier successful message", () => {
  const initial = createTurnState(1);
  const eligible = reduceTurnState(initial, assistant(reasoning));
  assert.equal(eligible.latestKind, "reasoning-only");
  for (const finish of ["max-tokens", "error", "aborted", "tool-calls"]) {
    assert.equal(reduceTurnState(initial, assistant(reasoning, { finish })).latestKind, "none");
  }
  assert.equal(reduceTurnState(initial, assistant(reasoning, { interrupted: true })).latestKind, "none");
  assert.equal(reduceTurnState(initial, assistant(reasoning, { stream: [] })).latestKind, "none");
  assert.equal(reduceTurnState(eligible, { type: "assistant/attempt", data: { turn: 1 } }).latestKind, "none");
});

test("a prior answer suppresses duplicate summaries, while tool commentary does not count as an answer", () => {
  let state = reduceTurnState(createTurnState(1), assistant([{ type: "text", text: "Answer already supplied" }]));
  state = reduceTurnState(state, assistant(reasoning));
  assert.equal(state.answered, true);
  assert.equal(state.latestKind, "reasoning-only");
  const commentary = reduceTurnState(createTurnState(1), assistant([
    { type: "text", text: "I will check the file" },
    { type: "tool-call", id: "call", name: "read", arguments: "{}" },
  ]));
  assert.equal(commentary.answered, false);
});

test("truncation remains sticky, and facts reset at the next turn instead of leaking across history", () => {
  let state = reduceTurnState(createTurnState(1), assistant(reasoning, { finish: "max-tokens" }));
  state = reduceTurnState(state, assistant(reasoning));
  assert.equal(state.truncated, true);
  assert.deepEqual(reduceTurnState(state, { type: "turn/start", data: { turn: 2 } }), {
    turn: 2, steers: 0, answered: false, truncated: false, optOut: false,
    latestKind: "none", provider: null, model: null,
  });
  const current = createTurnState(2);
  assert.equal(reduceTurnState(current, assistant(reasoning)), current);
});

test("only committed plugin prompts consume quota; a real user can opt out for one turn", () => {
  let state = createTurnState(1);
  state = reduceTurnState(state, { type: "user/message", data: {
    source: { kind: "plugin:xuxie" }, content: [{ type: "text", text: STEER_TEXT }],
  } });
  assert.equal(state.steers, 1);
  state = reduceTurnState(state, { type: "user/message", data: {
    source: { kind: "user" }, content: [{ type: "text", text: SILENT_MARKER }],
  } });
  assert.equal(state.optOut, true);
  const otherPlugin = reduceTurnState(createTurnState(1), { type: "user/message", data: {
    source: { kind: "plugin:other" }, content: [{ type: "text", text: SILENT_MARKER }],
  } });
  assert.equal(otherPlugin.optOut, false);
});

test("route and child-agent selection use actual provider/model and delegation rather than fork lineage", () => {
  const root = { session: { header: { delegationDepth: 0, parentSession: { id: "fork-parent" } } } };
  const config = resolveConfig({ models: ["grok"] });
  assert.equal(acceptsAgent(root, { provider: "xai", model: "grok" }, config), true);
  assert.equal(acceptsAgent(root, { provider: "other", model: "grok" }, config), false);
  assert.equal(acceptsAgent(root, { provider: "xai", model: "other" }, config), false);
  for (const header of [{ delegationDepth: 1 }, { origin: "subagent" }]) {
    const child = { session: { header } };
    assert.equal(acceptsAgent(child, { provider: "xai", model: "grok" }, config), false);
    assert.equal(acceptsAgent(child, { provider: "xai", model: "grok" }, resolveConfig({ includeSubagents: true })), true);
  }
  assert.equal(acceptsAgent(root, { provider: "custom", model: "custom" }, resolveConfig({ providers: [] })), true);
  assert.equal(acceptsAgent(root, { provider: "xai", model: "grok" }, resolveConfig({ enabled: false })), false);
});

test("invalid configuration and corrupted persisted state fail visibly", () => {
  for (const input of [null, [], { unknown: true }, { enabled: "yes" }, { maxSteersPerTurn: -1 },
    { maxSteersPerTurn: 1.5 }, { includeSubagents: 1 }, { providers: [""] }, { models: "grok" }]) {
    assert.throws(() => resolveConfig(input), /xuxie:/);
  }
  assert.deepEqual(resolveConfig({ providers: [" xai ", "xai"] }).providers, ["xai"]);
  assert.equal(resolveConfig({ maxSteersPerTurn: 0 }).maxSteersPerTurn, 0);
  const valid = createTurnState();
  assert.equal(turnStateSchema.parse(valid), valid);
  for (const state of [null, { ...valid, turn: -1 }, { ...valid, steers: 0.5 },
    { ...valid, latestKind: "completed" }, { ...valid, provider: 1 }]) {
    assert.throws(() => turnStateSchema.parse(state), /checkpoint/);
  }
});

test("continuation prompts retain producer-owned source and independent identities", () => {
  const first = steeringMessage();
  assert.equal(first.role, "user");
  assert.equal(first.source.kind, `plugin:${PLUGIN_ID}`);
  assert.equal(first.content[0].text, STEER_TEXT);
  assert.notEqual(first.id, steeringMessage().id);
});
