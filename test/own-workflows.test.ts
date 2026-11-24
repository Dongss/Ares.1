import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { defaultAgentsYaml, defaultSelfDevYaml } from '../src/config/defaults.js';
import { loadRepoTemplates } from '../src/config/load.js';
import { type AgentConfig, AgentSchema, AgentsFileSchema } from '../src/config/schema.js';
import { setLang } from '../src/i18n.js';
import { BUILTIN_CLIS, BUILTIN_READ_ONLY_CLIS } from '../src/master.js';

// This repo keeps its own workflow in .ares1/workflows/, which the Master running it reads from the
// target branch. It is the default self-dev template, kept the same so that improving the default
// improves the workflow Ares.1 develops itself with.
const workflowsDir = fileURLToPath(new URL('../.ares1/workflows/', import.meta.url));

function repoFiles(): { file: string; source: string }[] {
  return readdirSync(workflowsDir)
    .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
    .sort()
    .map((file) => ({ file, source: readFileSync(join(workflowsDir, file), 'utf8') }));
}

/** The enabled agents of the agents.yaml a first start writes. */
function defaultAgents(): Map<string, AgentConfig> {
  const file = AgentsFileSchema.parse(parseYaml(defaultAgentsYaml()));
  const agents = new Map<string, AgentConfig>();
  for (const [id, raw] of Object.entries(file.agents)) {
    const agent = AgentSchema.parse(raw);
    expect(BUILTIN_CLIS, `${id}: cli`).toContain(agent.cli);
    if (agent.enabled) agents.set(id, { ...agent, id });
  }
  return agents;
}

describe("this repo's own workflow templates (.ares1/workflows)", () => {
  beforeEach(() => setLang('zh'));
  afterEach(() => setLang('zh'));

  it('self-dev.yaml is the Chinese default self-dev template, word for word', () => {
    const source = readFileSync(join(workflowsDir, 'self-dev.yaml'), 'utf8');
    expect(source).toBe(defaultSelfDevYaml());
  });

  it("load as a repo's own templates with the default agents, without any error or warning", () => {
    const agents = defaultAgents();
    expect([...agents.keys()].sort()).toEqual(['claude-coder', 'claude-reviewer']);
    const files = repoFiles();
    const loaded = loadRepoTemplates('Ares.1', files, agents, BUILTIN_READ_ONLY_CLIS);
    // Every file loads, under the id of its file name.
    expect(loaded.files.map((f) => [f.file, f.templateId, f.errors, f.warnings])).toEqual(
      files.map(({ file }) => [file, file.replace(/\.ya?ml$/, ''), [], []]),
    );
    expect(loaded.templates.has('self-dev')).toBe(true);
    const selfDev = loaded.templates.get('self-dev');
    expect(selfDev?.stages.find((s) => s.id === 'implement')?.planning).toBe('auto');
  });
});
