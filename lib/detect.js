export const PLUGIN_ID = "xuxie";
export const PROJECTION_KEY = "xuxie/turn";
export const SILENT_MARKER = "<!-- xuxie:off -->";
export const STEER_TEXT = [
  "Your last step ended with reasoning but no answer or tool call.",
  "If the user expects a response, provide the requested answer or take the next necessary action.",
  "Respect the user's format, permission boundaries, and instructions to wait or remain silent.",
  "Do not repeat an answer already provided or invent unnecessary tool calls.",
].join(" ");

/** Validate deployment settings before registering any effects. Empty route lists allow all routes. */
export function resolveConfig(input = {}) {
  const defaults = {
    enabled: true, maxSteersPerTurn: 2, includeSubagents: false,
    providers: ["xai", "openai", "openai-codex"], models: [], skipIfAnswered: true,
  };
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("xuxie: config must be an object");
  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(defaults, key)) throw new Error(`xuxie: unknown config key ${key}`);
  }
  const config = { ...defaults, ...input };
  for (const key of ["enabled", "includeSubagents", "skipIfAnswered"]) {
    if (typeof config[key] !== "boolean") throw new Error(`xuxie: ${key} must be a boolean`);
  }
  if (!Number.isSafeInteger(config.maxSteersPerTurn) || config.maxSteersPerTurn < 0) {
    throw new Error("xuxie: maxSteersPerTurn must be a non-negative safe integer");
  }
  for (const key of ["providers", "models"]) {
    if (!Array.isArray(config[key]) || config[key].some((value) => typeof value !== "string" || !value.trim())) {
      throw new Error(`xuxie: ${key} must contain non-empty strings`);
    }
    config[key] = Object.freeze([...new Set(config[key].map((value) => value.trim()))]);
  }
  return Object.freeze(config);
}

export function acceptsAgent(agent, route, config) {
  if (!config.enabled) return false;
  const header = agent.session.header;
  if (!config.includeSubagents && (header.origin === "subagent" || header.delegationDepth > 0)) return false;
  return (config.providers.length === 0 || config.providers.includes(route.provider))
    && (config.models.length === 0 || config.models.includes(route.model));
}

export function isVisibleBlock(block) {
  if (!block || typeof block !== "object" || block.type === "reasoning") return false;
  if (block.type === "text") return String(block.text ?? "").trim().length > 0;
  return true;
}

export function isReasoningOnlyContent(content) {
  return Array.isArray(content) && !content.some(isVisibleBlock)
    && content.some((block) => block?.type === "reasoning" && String(block.text ?? "").trim().length > 0);
}

export function createTurnState(turn = 0) {
  return { turn, steers: 0, answered: false, truncated: false, optOut: false, latestKind: "none", provider: null, model: null };
}

/** Fold only current-turn facts; never retain message text or a full stream/history snapshot. */
export function reduceTurnState(state, event) {
  const data = event.data;
  if (event.type === "turn/start") return createTurnState(data.turn);
  if (event.type === "user/message") {
    if (data.source.kind === `plugin:${PLUGIN_ID}`) return { ...state, steers: state.steers + 1 };
    if (data.source.kind === "user" && data.content.some((block) => block.type === "text" && block.text.includes(SILENT_MARKER))) {
      return { ...state, optOut: true };
    }
    return state;
  }
  if (data?.turn !== state.turn) return state;
  if (event.type === "assistant/attempt") return { ...state, latestKind: "none" };
  if (event.type !== "assistant/message") return state;
  const content = data.message.content;
  const terminal = data.stream.at(-1);
  const finish = terminal?.type === "chunk" && terminal.chunk.type === "finish" ? terminal.chunk.reason.kind : undefined;
  const normalStop = !data.interrupted && finish === "stop";
  const hasTools = content.some((block) => block.type === "tool-call");
  const answered = normalStop && !hasTools && content.some(isVisibleBlock);
  return {
    ...state, answered: state.answered || answered,
    truncated: state.truncated || finish === "max-tokens",
    latestKind: normalStop && isReasoningOnlyContent(content) ? "reasoning-only" : "none",
    provider: data.message.source.provider, model: data.message.source.model,
  };
}

/** Validate the persisted projection cache, including its route and decision fields. */
export const turnStateSchema = {
  parse(state) {
    if (!state || typeof state !== "object"
      || !Number.isSafeInteger(state.turn) || state.turn < 0
      || !Number.isSafeInteger(state.steers) || state.steers < 0
      || ["answered", "truncated", "optOut"].some((key) => typeof state[key] !== "boolean")
      || !["none", "reasoning-only"].includes(state.latestKind)
      || ["provider", "model"].some((key) => state[key] !== null && typeof state[key] !== "string")) {
      throw new Error("xuxie: invalid turn projection checkpoint");
    }
    return state;
  },
};

export function steeringMessage() {
  return {
    id: crypto.randomUUID(), role: "user", content: [{ type: "text", text: STEER_TEXT }],
    source: { kind: `plugin:${PLUGIN_ID}` },
  };
}
