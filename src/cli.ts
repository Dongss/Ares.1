#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { brandName } from './brand.js';
import { ConfigError } from './config/load.js';
import { langOfLocale, setLang, t } from './i18n.js';
import { Master } from './master.js';

function usage(): string {
  return t({
    zh: `用法：ares1 [--home <目录>] [--port <端口>]

启动${brandName()} Master 服务（只监听 127.0.0.1）。

  --home   数据目录，默认 $ARES1_HOME 或 ~/.ares1
  --port   端口，默认使用 config.yaml 中的 port（4870）
`,
    en: `Usage: ares1 [--home <dir>] [--port <port>]

Start the ${brandName()} Master (listens on 127.0.0.1 only).

  --home   data directory, default $ARES1_HOME or ~/.ares1
  --port   port, default config.yaml's port (4870)
`,
  });
}

/** The language the system asks for, used until config.yaml's is loaded. */
function systemLang() {
  const env = process.env;
  return (
    langOfLocale(env.LC_ALL || env.LC_MESSAGES || env.LANG) ??
    langOfLocale(Intl.DateTimeFormat().resolvedOptions().locale)
  );
}

async function main(): Promise<void> {
  const language = systemLang() ?? undefined;
  if (language) setLang(language);
  const { values } = parseArgs({
    options: {
      home: { type: 'string' },
      port: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    process.stdout.write(usage());
    return;
  }
  const home = values.home ?? process.env.ARES1_HOME ?? join(homedir(), '.ares1');
  const port = values.port === undefined ? undefined : Number(values.port);
  if (port !== undefined && !Number.isInteger(port))
    throw new ConfigError(t({ zh: '--port 必须是整数', en: '--port must be an integer' }));

  // Running from a build (dist/cli.js) in a git checkout: that checkout can be upgraded.
  const here = fileURLToPath(new URL('.', import.meta.url));
  const root = fileURLToPath(new URL('..', import.meta.url));
  const installDir =
    /[/\\]dist[/\\]$/.test(here) && existsSync(join(root, '.git'))
      ? root.replace(/[/\\]$/, '')
      : null;

  const master = await Master.open({ home, installDir, language });
  for (const [key, errors] of Object.entries(master.config.errors)) {
    console.warn(
      t({
        zh: `[配置] ${key} 已禁用：\n  ${errors.join('\n  ')}`,
        en: `[config] ${key} is disabled:\n  ${errors.join('\n  ')}`,
      }),
    );
  }
  for (const [key, warnings] of Object.entries(master.config.warnings)) {
    console.warn(
      t({
        zh: `[配置] ${key}：\n  ${warnings.join('\n  ')}`,
        en: `[config] ${key}:\n  ${warnings.join('\n  ')}`,
      }),
    );
  }
  const url = await master.listen(port);
  console.log(
    t({
      zh: `${brandName()} Master 已启动，看板：${url}（数据目录 ${home}）`,
      en: `${brandName()} Master started, dashboard: ${url} (data directory ${home})`,
    }),
  );

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    console.log(
      t({
        zh: `收到 ${signal}，正在停止（正在执行的 Run 会回到队首）…`,
        en: `Got ${signal}, stopping (the executing Run goes back to the head of the queue)…`,
      }),
    );
    await master.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  console.error(err instanceof ConfigError ? err.message : err);
  process.exit(1);
});
