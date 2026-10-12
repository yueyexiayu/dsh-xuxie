/** Only normalize whitespace blocks; zero-block EMPTY_RESPONSE belongs to the official adapter. */
export async function installEmptyResponseGuard(ctx, acceptsAgent) {
  const { BlockAssembler, EMPTY_RESPONSE_CODE } = await ctx.loader.import("@deepseek-ai/dsh-llm");
  ctx.on("llm/stream", (options, next) => {
    const agent = options.sessionId === undefined ? undefined : ctx.agents.get(options.sessionId);
    if (options.purpose !== undefined || agent === undefined
      || !acceptsAgent(agent, { provider: options.provider, model: options.model })) return next();

    return (async function* () {
      const assembler = new BlockAssembler();
      for await (const chunk of next()) {
        assembler.push(chunk);
        const blocks = chunk.type === "finish" ? assembler.blocks() : [];
        if (chunk.type === "finish" && chunk.reason.kind === "stop" && !options.signal?.aborted
          && blocks.length > 0 && blocks.every((block) =>
            (block.type === "text" || block.type === "reasoning") && block.text.trim() === "")) {
          const { replayState: _successfulReplay, ...terminal } = chunk;
          yield {
            ...terminal,
            reason: {
              kind: "error",
              failure: {
                code: EMPTY_RESPONSE_CODE,
                message: `model "${options.model}" returned a completed response with no content`,
              },
            },
          };
        } else {
          yield chunk;
        }
      }
    })();
  });
}
