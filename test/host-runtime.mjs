import { readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";

let loaded;
/** Load the existing Host build; missing dependencies fail rather than silently skipping acceptance. */
export function hostModules() {
  loaded ??= (async () => {
    const root = process.env.DSH_TEST_ROOT || path.join(os.homedir(), "Documents", "dsh");
    const directories = {
      cordis: "vendor/cordis", llm: "packages/llm/llm", session: "packages/core/session",
      projections: "packages/session/session-projection", systemPrompt: "packages/core/system-prompt",
      tools: "packages/core/tools", agents: "packages/core/agent", agentLoop: "packages/core/agent-loop",
      retry: "packages/llm/llm-retry", loader: "vendor/loader",
    };
    const entries = await Promise.all(Object.entries(directories).map(async ([name, directory]) => {
      const base = path.join(root, directory);
      const manifest = JSON.parse(await readFile(path.join(base, "package.json"), "utf8"));
      const target = manifest.module || manifest.main;
      if (!target) throw new Error(`DSH Host ${name} has no runtime entry`);
      return [name, await import(pathToFileURL(path.join(base, target)).href)];
    }));
    return Object.fromEntries(entries);
  })();
  return loaded;
}
