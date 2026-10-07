import {
  PLUGIN_ID, PROJECTION_KEY, acceptsAgent, createTurnState, reduceTurnState,
  resolveConfig, steeringMessage, turnStateSchema,
} from "./detect.js";
import { installEmptyResponseGuard } from "./empty-response.js";

export const name = PLUGIN_ID;
export const inject = ["loader", "agents", "llm", "sessionProjections"];

export async function apply(ctx, input = {}) {
  const config = resolveConfig(input);
  if (!config.enabled) return;
  const { LlmError } = await ctx.loader.import("@deepseek-ai/dsh-llm");
  const accepts = (agent, route) => {
    if (!acceptsAgent(agent, route, config)) return false;
    const state = ctx.sessionProjections.stateOf(agent.session, PROJECTION_KEY);
    if (!state) throw new Error("xuxie: turn projection is unavailable");
    return !state.optOut && !state.truncated && !(config.skipIfAnswered && state.answered);
  };
  ctx.effect(() => ctx.sessionProjections.register({
    key: PROJECTION_KEY, stateVersion: 1, stateSchema: turnStateSchema,
    init: () => createTurnState(), apply: reduceTurnState,
  }));
  await installEmptyResponseGuard(ctx, accepts);

  const candidates = new WeakMap();
  ctx.on("agent/turn-stopping", ({ agent, turn, signal }) => {
    if (signal.aborted || agent.inbox.nextStep.length > 0) return;
    const state = ctx.sessionProjections.stateOf(agent.session, PROJECTION_KEY);
    if (!state) throw new Error("xuxie: turn projection is unavailable");
    if (state.turn !== turn || state.latestKind !== "reasoning-only" || state.truncated || state.optOut
      || (config.skipIfAnswered && state.answered) || !accepts(agent, state)) return;
    const message = steeringMessage();
    candidates.set(agent, { id: message.id, turn });
    agent.steer(message);
  });

  // The outer middleware sees later Stop listeners and downstream step rewrites.
  // A candidate discarded here never reaches the model or consumes the quota.
  ctx.on("agent/pre-step", async ({ agent, turn, signal }, next) => {
    const decision = await next();
    const candidate = candidates.get(agent);
    if (!candidate || candidate.turn !== turn) return decision;
    candidates.delete(agent);
    if (decision.kind !== "enter" || !decision.messages.some((message) => message.id === candidate.id)) return decision;
    signal.throwIfAborted();
    const others = decision.messages.filter((message) => message.id !== candidate.id && message.source.kind !== "runtime-context");
    if (others.length > 0) {
      return { ...decision, messages: decision.messages.filter((message) => message.id !== candidate.id) };
    }
    const state = ctx.sessionProjections.stateOf(agent.session, PROJECTION_KEY);
    if (!state) throw new Error("xuxie: turn projection is unavailable");
    if (state.steers >= config.maxSteersPerTurn) {
      throw new LlmError(`xuxie 已续写 ${state.steers} 次，模型仍只输出思考，没有给用户的答案。`, "XUXIE_NO_ANSWER");
    }
    return decision;
  }, { prepend: true });
}
