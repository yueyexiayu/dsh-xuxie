import {
  PLUGIN_ID, PROJECTION_KEY, acceptsAgent, createTurnState, reduceTurnState,
  resolveConfig, steeringMessage, turnStateSchema,
} from "./detect.js";
import { installEmptyResponseGuard } from "./empty-response.js";

export const name = PLUGIN_ID;
export const inject = ["loader", "agents", "llm", "sessionProjections"];

export async function apply(ctx, input = {}) {
  const config = resolveConfig(input);
  const { LlmError } = config.enabled ? await ctx.loader.import("@deepseek-ai/dsh-llm") : {};
  const stateOf = (agent) => {
    const state = ctx.sessionProjections.stateOf(agent.session, PROJECTION_KEY);
    if (!state) throw new Error("xuxie: turn projection is unavailable");
    return state;
  };
  const accepts = (agent, route) => {
    if (!acceptsAgent(agent, route, config)) return false;
    const state = stateOf(agent);
    return !state.optOut && !state.truncated && !(config.skipIfAnswered && state.answered);
  };
  const needsContinuation = (agent, turn, state) => state.turn === turn
    && state.latestKind === "reasoning-only" && accepts(agent, state);

  if (config.enabled) {
    ctx.effect(() => ctx.sessionProjections.register({
      key: PROJECTION_KEY, stateVersion: 1, stateSchema: turnStateSchema,
      init: () => createTurnState(), apply: reduceTurnState,
    }));
    await installEmptyResponseGuard(ctx, accepts);
    ctx.on("agent/turn-stopping", ({ agent, turn, signal }) => {
      if (signal.aborted || agent.inbox.nextStep.length > 0) return;
      if (needsContinuation(agent, turn, stateOf(agent))) agent.steer(steeringMessage());
    });
  }

  // Inbox messages survive cancellation, resume and reload; a WeakMap does not.
  // Revalidate every producer-owned candidate at admission, even when disabled.
  // The outer middleware sees later Stop listeners and downstream step rewrites.
  ctx.on("agent/pre-step", async ({ agent, turn, signal }, next) => {
    const decision = await next();
    if (decision.kind !== "enter") return decision;
    const isCandidate = (message) => message.source.kind === `plugin:${PLUGIN_ID}`;
    const first = decision.messages.findIndex(isCandidate);
    if (first < 0) return decision;
    signal.throwIfAborted();
    const others = decision.messages.filter((message) => !isCandidate(message));
    if (others.some((message) => message.source.kind !== "runtime-context")) {
      return { ...decision, messages: others };
    }
    // An orphan runtime-context snapshot must not turn a discarded reminder into
    // a model request. It is uncommitted and will be projected on the next input.
    if (!config.enabled) return { ...decision, messages: [] };
    const state = stateOf(agent);
    if (!needsContinuation(agent, turn, state)) return { ...decision, messages: [] };
    if (state.steers >= config.maxSteersPerTurn) {
      throw new LlmError(`xuxie 已续写 ${state.steers} 次，模型仍只输出思考，没有给用户的答案。`, "XUXIE_NO_ANSWER");
    }
    // One step may commit at most one reminder; retain the original message order.
    return { ...decision, messages: decision.messages.filter((message, index) => !isCandidate(message) || index === first) };
  }, { prepend: true });
}
