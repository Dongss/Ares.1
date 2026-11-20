// Dependency-free helpers about an agent's effort, shared by the Master and the dashboard.

/** Whether a CLI argument sets the effort ("--effort" or "--effort=<e>"). */
export const isEffortArg = (arg: string): boolean =>
  arg === '--effort' || arg.startsWith('--effort=');

/**
 * The effort an agent runs with: its `effort` field, or a `--effort` left in `args`
 * (older configs). Undefined when neither is set, i.e. the CLI default.
 */
export function agentEffort(agent: {
  effort?: string;
  args: readonly string[];
}): string | undefined {
  if (agent.effort) return agent.effort;
  const i = agent.args.findIndex(isEffortArg);
  if (i < 0) return undefined;
  const arg = agent.args[i] as string;
  return arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : agent.args[i + 1];
}
