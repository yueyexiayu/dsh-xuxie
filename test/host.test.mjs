import test from "node:test";
import assert from "node:assert/strict";
import { apply, inject } from "../lib/index.js";
import { hostModules } from "./host-runtime.mjs";

const modules = await hostModules();
const { llm, cordis, session, projections, systemPrompt, tools, agents, agentLoop, retry } = modules;
let serial = 0;

function response(blocks, kind = "stop") {
  return [...blocks.flatMap((block, index) => [
    { type: "block-start", index, blockType: block.type },
    { type: "block-end", index, block },
  ]), { type: "finish", reason: { kind } }];
}
const reasoning = () => response([{ type: "reasoning", text: "Thinking through the result." }]);
const answer = (text = "The verified answer.") => response([{ type: "text", text }]);
const empty = () => response([{ type: "reasoning", text: "" }, { type: "text", text: "  " }]);

class ScriptedAdapter extends llm.LlmAdapter {
  requests = [];
  constructor(entries, policy) { super(); this.entries = [...entries]; this.policy = policy; }
  resolveModel(provider, model) { return Promise.resolve({ provider, id: model, name: model }); }
  providerRetryPolicy() { return this.policy; }
  async *stream(options) {
    this.requests.push(options);
    const entry = this.entries.shift();
    if (entry === undefined) throw new Error("Host test adapter script exhausted");
    const chunks = typeof entry === "function" ? await entry(options) : entry;
    if (chunks instanceof Error) throw chunks;
    yield* chunks;
  }
}

async function harness(t, entries, options = {}) {
  const ctx = new cordis.Context();
  t.after(async () => { await ctx.fiber.dispose(); });
  for (const plugin of [llm.default, session.default, projections.default, systemPrompt.default, tools.default, agents.default]) {
    await ctx.plugin(plugin);
  }
  await ctx.plugin(agentLoop.default, { agents: [] });
  ctx.provide("loader", { import: async (name) => {
    assert.equal(name, "@deepseek-ai/dsh-llm");
    return llm;
  } });
  const policy = options.retryPolicy === undefined ? undefined : llm.resolveRetryPolicy(options.retryPolicy, "test provider retryPolicy");
  const adapter = new ScriptedAdapter(entries, policy);
  ctx.llm.registerAdapter(["mock", "other"], adapter);
  const events = [];
  const errors = [];
  ctx.on("session/event", (owner, event) => events.push({ owner, event }));
  ctx.on("agent/error", (payload) => errors.push(payload));
  if (options.retryPolicy) await ctx.plugin(retry);
  const plugin = { inject, apply: async (inner) => apply(inner, { providers: ["mock"], ...options.config }) };
  let fiber;
  const mount = async () => { fiber = await ctx.plugin(plugin); return fiber; };
  if (options.beforeMount) options.beforeMount(ctx);
  if (!options.noMount) await mount();
  async function create(meta = {}, agentOptions = {}, seed) {
    const id = session.SessionId(`xuxie-host-${++serial}`);
    return (await ctx.agents.create({ sessionId: id, meta, agentOptions: { provider: "mock", model: "test-model", ...agentOptions }, ...seed })).agent;
  }
  async function send(agent, text = "Please answer the question.") {
    const idle = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { dispose(); reject(new Error("Host test turn did not settle within 3 seconds")); }, 3000);
      const dispose = ctx.on("agent/status", ({ agent: owner, status }) => {
        if (owner === agent && status === "idle") { clearTimeout(timer); dispose(); resolve(); }
      });
    });
    agent.followup(llm.createUserMessage({ content: [{ type: "text", text }], source: { kind: "user" } }));
    await idle;
    await agent.done;
  }
  const ownEvents = (agent) => events.filter(({ owner }) => owner === agent.session).map(({ event }) => event);
  const end = (agent) => ownEvents(agent).findLast((event) => event.type === "turn/end").data.reason;
  const steers = (agent) => ownEvents(agent).filter((event) => event.type === "user/message" && event.data.source.kind === "plugin:xuxie");
  return { ctx, adapter, create, send, end, steers, ownEvents, errors, mount, get fiber() { return fiber; } };
}

function stopHook(ctx, call) {
  ctx.on("agent/turn-stopping", ({ agent, turn }) => {
    if (!call(agent, turn)) return;
    agent.steer(llm.createUserMessage({ content: [{ type: "text", text: "Continue because the Stop hook found work." }], source: { kind: "plugin:test-hook" } }));
  });
}

function forbidPluginSnapshotReads(agent) {
  const original = agent.session.snapshotEvents.bind(agent.session);
  const pluginLibUrl = new URL("../lib/", import.meta.url).href;
  agent.session.snapshotEvents = (...args) => {
    const caller = new Error().stack.split("\n")[2];
    assert.ok(!caller.includes(pluginLibUrl), "xuxie must use the public projection rather than snapshotEvents");
    return original(...args);
  };
}

test("real Host resumes reasoning-only stop and commits one attributed reminder", async (t) => {
  const h = await harness(t, [reasoning(), answer()]);
  const agent = await h.create();
  forbidPluginSnapshotReads(agent);
  await h.send(agent);
  assert.equal(h.adapter.requests.length, 2);
  assert.equal(h.steers(agent).length, 1);
  assert.equal(h.end(agent).kind, "completed");
  assert.equal(h.errors.length, 0);
});

test("exhaustion produces a durable structured failure and the next user turn still runs", async (t) => {
  const h = await harness(t, [reasoning(), reasoning(), reasoning(), answer()]);
  const agent = await h.create();
  await h.send(agent);
  assert.equal(h.adapter.requests.length, 3);
  assert.equal(h.steers(agent).length, 2);
  assert.equal(h.end(agent).kind, "error");
  assert.equal(h.end(agent).error.code, "XUXIE_NO_ANSWER");
  assert.equal(h.errors.length, 1);
  assert.equal(h.errors[0].error.code, "XUXIE_NO_ANSWER");
  assert.equal(agent.inbox.nextStep.length, 0);
  await h.send(agent, "Try a new question.");
  assert.equal(h.adapter.requests.length, 4);
  assert.equal(h.end(agent).kind, "completed");
});

for (const order of ["before", "after"]) {
  test(`Stop hook registered ${order} xuxie takes precedence without spending a continuation`, async (t) => {
    let stopped = false;
    const install = (ctx) => stopHook(ctx, () => !stopped && (stopped = true));
    const h = await harness(t, [reasoning(), answer()], { beforeMount: order === "before" ? install : undefined });
    if (order === "after") install(h.ctx);
    const agent = await h.create();
    await h.send(agent);
    assert.equal(h.adapter.requests.length, 2);
    assert.equal(h.steers(agent).length, 0);
    assert.equal(h.end(agent).kind, "completed");
    assert.ok(h.adapter.requests[1].messages.some((message) => message.source.kind === "plugin:test-hook"));
    assert.ok(!h.adapter.requests[1].messages.some((message) => message.source.kind === "plugin:xuxie"));
  });
}

test("a later Stop hook can take over after both xuxie reminders have been spent", async (t) => {
  const h = await harness(t, [reasoning(), reasoning(), reasoning(), answer()]);
  let stops = 0;
  stopHook(h.ctx, () => ++stops === 3);
  const agent = await h.create();
  await h.send(agent);
  assert.equal(h.adapter.requests.length, 4);
  assert.equal(h.steers(agent).length, 2);
  assert.equal(h.end(agent).kind, "completed");
  assert.equal(h.errors.length, 0);
});

test("a changed automatic runtime context does not erase xuxie steering", async (t) => {
  const h = await harness(t, [reasoning(), answer()]);
  let text = "Initial runtime policy.";
  h.ctx.on("system-prompt/assemble", async (_assembly, _context, next) => ({ ...await next(), contexts: [{ name: "test:policy", text, order: 0 }] }));
  h.ctx.on("agent/turn-stopping", () => { text = "Updated runtime policy."; });
  const agent = await h.create();
  await h.send(agent);
  assert.equal(h.adapter.requests.length, 2);
  assert.equal(h.steers(agent).length, 1);
  assert.ok(h.adapter.requests[1].messages.some((message) => message.source.kind === "runtime-context" && JSON.stringify(message.content).includes("Updated runtime policy")));
});

test("pre-step middleware context takes precedence over the candidate reminder", async (t) => {
  const h = await harness(t, [reasoning(), answer()]);
  h.ctx.on("agent/pre-step", async ({ step }, next) => {
    const decision = await next();
    if (step !== 2 || decision.kind !== "enter") return decision;
    return { ...decision, messages: [...decision.messages, llm.createUserMessage({ content: [{ type: "text", text: "Additional middleware work." }], source: { kind: "plugin:test-middleware" } })] };
  });
  const agent = await h.create();
  await h.send(agent);
  assert.equal(h.adapter.requests.length, 2);
  assert.equal(h.steers(agent).length, 0);
});

test("a rejected candidate pre-step spends no reminder and preserves the blocked outcome", async (t) => {
  const h = await harness(t, [reasoning()]);
  h.ctx.on("agent/pre-step", async ({ step }, next) => step === 2 ? { kind: "reject" } : next());
  const agent = await h.create();
  await h.send(agent);
  assert.equal(h.adapter.requests.length, 1);
  assert.equal(h.steers(agent).length, 0);
  assert.equal(h.end(agent).kind, "blocked");
  assert.equal(h.ctx.sessionProjections.stateOf(agent.session, "xuxie/turn").steers, 0);
});

test("a candidate removed by downstream middleware never reaches the model or spends quota", async (t) => {
  const h = await harness(t, [reasoning()]);
  h.ctx.on("agent/pre-step", async ({ step }, next) => {
    const decision = await next();
    return step === 2 && decision.kind === "enter"
      ? { ...decision, messages: decision.messages.filter((message) => message.source.kind !== "plugin:xuxie") }
      : decision;
  });
  const agent = await h.create();
  await h.send(agent);
  assert.equal(h.adapter.requests.length, 1);
  assert.equal(h.steers(agent).length, 0);
  assert.equal(h.ctx.sessionProjections.stateOf(agent.session, "xuxie/turn").steers, 0);
});

test("a configured zero continuation allowance fails visibly before another model request", async (t) => {
  const h = await harness(t, [reasoning()], { config: { maxSteersPerTurn: 0 } });
  const agent = await h.create();
  await h.send(agent);
  assert.equal(h.adapter.requests.length, 1);
  assert.equal(h.steers(agent).length, 0);
  assert.equal(h.end(agent).error.code, "XUXIE_NO_ANSWER");
});

test("earlier standalone answer prevents a duplicate final answer", async (t) => {
  const h = await harness(t, [answer("Already answered."), reasoning()]);
  let continued = false;
  stopHook(h.ctx, () => !continued && (continued = true));
  const agent = await h.create();
  await h.send(agent);
  assert.equal(h.adapter.requests.length, 2);
  assert.equal(h.steers(agent).length, 0);
  assert.equal(h.end(agent).kind, "completed");
});

test("text accompanying a tool call is commentary and does not suppress the missing final answer", async (t) => {
  const call = { type: "tool-call", id: llm.ToolCallId("xuxie-test-tool"), name: "lookup", arguments: "{}" };
  const h = await harness(t, [response([{ type: "text", text: "I will look it up." }, call], "tool-calls"), reasoning(), answer()]);
  h.ctx.tools.register(tools.defineContentToolFixture({ name: "lookup", description: "Test lookup", parameters: {}, execute: async () => [{ type: "text", text: "Lookup result." }] }));
  const agent = await h.create();
  await h.send(agent);
  assert.equal(h.adapter.requests.length, 3);
  assert.equal(h.steers(agent).length, 1);
  assert.equal(h.end(agent).kind, "completed");
});

test("max-tokens remains sticky after an external hook continues with a normal reasoning-only stop", async (t) => {
  const h = await harness(t, [response([{ type: "reasoning", text: "Truncated reasoning." }], "max-tokens"), reasoning()]);
  let once = false;
  stopHook(h.ctx, () => !once && (once = true));
  const agent = await h.create();
  await h.send(agent);
  assert.equal(h.adapter.requests.length, 2);
  assert.equal(h.steers(agent).length, 0);
  assert.equal(h.end(agent).kind, "max-tokens");
});

test("cancellation after streamed reasoning is never restarted by xuxie", async (t) => {
  const h = await harness(t, [async function* (options) {
    yield { type: "block-start", index: 0, blockType: "reasoning" };
    yield { type: "reasoning-delta", index: 0, text: "Interrupted reasoning." };
    yield { type: "block-end", index: 0, block: { type: "reasoning", text: "Interrupted reasoning." } };
    h.ctx.agents.get(options.sessionId).cancel({ kind: "user" });
  }]);
  const agent = await h.create();
  await h.send(agent);
  assert.equal(h.adapter.requests.length, 1);
  assert.equal(h.steers(agent).length, 0);
  assert.equal(h.end(agent).kind, "aborted");
});

test("a failed request remains an error without a continuation reminder", async (t) => {
  const h = await harness(t, [[{ type: "finish", reason: { kind: "error", failure: { code: "NETWORK", message: "Test provider failure." } } }]]);
  const agent = await h.create();
  await h.send(agent);
  assert.equal(h.adapter.requests.length, 1);
  assert.equal(h.steers(agent).length, 0);
  assert.equal(h.end(agent).error.code, "NETWORK");
});

for (const includeSubagents of [false, true]) {
  test(`subagent scope is ${includeSubagents ? "explicitly enabled" : "excluded by default"}`, async (t) => {
    const h = await harness(t, [reasoning(), answer()], { config: { includeSubagents } });
    const agent = await h.create({ origin: "subagent", delegationDepth: 1 });
    await h.send(agent);
    assert.equal(h.adapter.requests.length, includeSubagents ? 2 : 1);
    assert.equal(h.steers(agent).length, includeSubagents ? 1 : 0);
  });
}

test("a normal fork lineage does not misclassify the session as a subagent", async (t) => {
  const h = await harness(t, [reasoning(), answer()]);
  const agent = await h.create({ parentSession: session.SessionId("ordinary-parent") });
  await h.send(agent);
  assert.equal(h.steers(agent).length, 1);
});

for (const scenario of [
  { label: "disabled", config: { enabled: false } },
  { label: "provider filter", config: { providers: ["other"] } },
  { label: "model filter", config: { models: ["different-model"] } },
]) {
  test(`${scenario.label} leaves the stop untouched`, async (t) => {
    const h = await harness(t, [reasoning()], scenario);
    const agent = await h.create();
    await h.send(agent);
    assert.equal(h.adapter.requests.length, 1);
    assert.equal(h.steers(agent).length, 0);
  });
}

test("filters follow the actual route rewritten by agent/request", async (t) => {
  const h = await harness(t, [reasoning(), answer()], { config: { providers: ["other"], models: ["routed-model"] } });
  h.ctx.on("agent/request", async (_payload, next) => ({ ...await next(), provider: "other", model: "routed-model" }));
  const agent = await h.create();
  await h.send(agent);
  assert.equal(h.adapter.requests.length, 2);
  assert.equal(h.adapter.requests[0].provider, "other");
  assert.equal(h.steers(agent).length, 1);
});

test("the explicit per-turn opt-out applies only to the marked user turn", async (t) => {
  const h = await harness(t, [reasoning(), reasoning(), answer()]);
  const agent = await h.create();
  await h.send(agent, "Wait silently. <!-- xuxie:off -->");
  assert.equal(h.adapter.requests.length, 1);
  await h.send(agent, "Now answer.");
  assert.equal(h.adapter.requests.length, 3);
  assert.equal(h.steers(agent).length, 1);
});

test("late load and plugin reload reconstruct current turn state without deprecated reads", async (t) => {
  const h = await harness(t, [reasoning(), answer(), reasoning(), answer()], { noMount: true });
  const agent = await h.create();
  forbidPluginSnapshotReads(agent);
  await h.mount();
  await h.send(agent);
  assert.equal(h.adapter.requests.length, 2);
  assert.equal(h.steers(agent).length, 1);
  await h.fiber.dispose();
  await h.mount();
  await h.send(agent, "A question after reloading the plugin.");
  assert.equal(h.adapter.requests.length, 4);
  assert.equal(h.steers(agent).length, 2);
});

test("resuming a stored old session applies xuxie to its new turn", async (t) => {
  const h = await harness(t, [answer("An answer from the old lifecycle."), reasoning(), answer()]);
  const id = session.SessionId(`xuxie-resume-${++serial}`);
  const old = await h.ctx.agents.create({ sessionId: id, agentOptions: { provider: "mock", model: "test-model" } });
  await h.send(old.agent);
  const header = old.agent.session.header;
  const persisted = h.ownEvents(old.agent);
  await old.dispose();
  h.ctx.provide("sessionPersistence", { open: async () => ({
    header, inheritedEventCount: 0,
    read: async () => ({ events: [...persisted], eventState: "shared-frozen" }),
    append: async (events) => { persisted.push(...events); },
    close: async () => {},
  }) });
  let resumed = false;
  h.ctx.on("agent/created", ({ source }) => { if (source === "resume") resumed = true; });
  const handle = await h.ctx.agents.resume({ resumeSessionId: id, agentOptions: { provider: "mock", model: "test-model" } });
  assert.equal(resumed, true);
  await h.send(handle.agent);
  assert.equal(h.adapter.requests.length, 3);
  assert.equal(h.steers(handle.agent).length, 1);
  assert.equal(h.end(handle.agent).kind, "completed");
});

const retryPolicy = { mode: "normal", maxRetries: 1, retryableCodes: ["EMPTY_RESPONSE"], backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 } };
test("blank content delegates to official request retry and then returns a normal answer", async (t) => {
  const h = await harness(t, [empty(), answer()], { retryPolicy });
  const agent = await h.create();
  await h.send(agent);
  assert.equal(h.adapter.requests.length, 2);
  assert.equal(h.steers(agent).length, 0);
  assert.equal(h.end(agent).kind, "completed");
  assert.ok(h.ownEvents(agent).some((event) => event.type === "llm/retry"));
  assert.equal(h.ownEvents(agent).filter((event) => event.type === "assistant/attempt").length, 1);
});

test("blank content exhausting official retries is a visible EMPTY_RESPONSE failure", async (t) => {
  const h = await harness(t, [empty(), empty()], { retryPolicy });
  const agent = await h.create();
  await h.send(agent);
  assert.equal(h.adapter.requests.length, 2);
  assert.equal(h.steers(agent).length, 0);
  assert.equal(h.end(agent).kind, "error");
  assert.equal(h.end(agent).error.code, "EMPTY_RESPONSE");
  assert.equal(h.errors.length, 1);
});

test("the per-turn opt-out also prevents blank-content normalization and official retries", async (t) => {
  const h = await harness(t, [empty()], { retryPolicy });
  const agent = await h.create();
  await h.send(agent, "Wait silently. <!-- xuxie:off -->");
  assert.equal(h.adapter.requests.length, 1);
  assert.equal(h.steers(agent).length, 0);
  assert.ok(!h.ownEvents(agent).some((event) => event.type === "llm/retry"));
  assert.equal(h.end(agent).kind, "completed");
});
