/** One-line summary of a tool call's input for live views: the command, path, etc. */
export function summarizeToolInput(input: unknown): string {
  if (input && typeof input === 'object') {
    const o = input as Record<string, unknown>;
    for (const key of ['command', 'file_path', 'path', 'pattern', 'url', 'description']) {
      if (typeof o[key] === 'string') return (o[key] as string).slice(0, 300);
    }
  }
  const text = JSON.stringify(input) ?? '';
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}
