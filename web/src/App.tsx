import { type ReactNode, useEffect, useState } from 'react';
import type { ConfigView, RunSummary } from '../../src/api/types.js';
import { brandName } from '../../src/brand.js';
import { join, LANG_NAMES, type Lang, lang, t } from '../../src/i18n.js';
import type { Repo } from '../../src/store/types.js';
import { NotifyBanner, NotifyToggle } from './components/Notifications.js';
import { Empty, ErrorBox } from './components/ui.js';
import { useWorkSwitch, WorkOffBanner, WorkToggle } from './components/WorkSwitch.js';
import { api } from './lib/api.js';
import { formatTime } from './lib/format.js';
import { type Resource, useReloadOn, useResource } from './lib/hooks.js';
import { applyLang, dashboardLang, storedLang, storeLang } from './lib/lang.js';
import { useNotifications } from './lib/notifications.js';
import { href, type Route, useRoute } from './lib/router.js';
import { attentionCount, pageTitle } from './lib/runs.js';
import { useConnected } from './lib/stream.js';
import { AgentsPage } from './pages/Agents.js';
import { ConfigPage } from './pages/Config.js';
import { EventsPage } from './pages/Events.js';
import { GuidePage } from './pages/Guide.js';
import { HomePage } from './pages/Home.js';
import { IssuesPage } from './pages/Issues.js';
import { IterationsPage } from './pages/Iterations.js';
import { ReposPage } from './pages/Repos.js';
import { RunDetailPage } from './pages/RunDetail.js';
import { StatsPage } from './pages/Stats.js';
import { WorkspacesPage } from './pages/Workspaces.js';

export function App() {
  const route = useRoute();
  const connected = useConnected();
  const runs = useResource(() => api.runs(), 'runs');
  const repos = useResource(() => api.repos(), 'repos');
  const config = useResource(() => api.config(), 'config');
  useReloadOn(runs.reload, () => true);
  // After a reload of the files, and after a reconnect (the Master may have restarted).
  useReloadOn(
    config.reload,
    (e) => e.type === 'config.reloaded' || e.type === 'config.reload_failed',
  );
  useReloadOn(repos.reload, () => false);

  // Re-rendered (and the page remounted) when the language changes; texts are picked at render.
  const [language, setLanguage] = useState<Lang>(lang());
  const switchLang = (l: Lang) => {
    applyLang(l);
    setLanguage(l);
  };
  const masterLang = config.data?.language;
  useEffect(() => {
    const want = dashboardLang(storedLang(), masterLang);
    if (want !== lang()) {
      applyLang(want);
      setLanguage(want);
    }
  }, [masterLang]);

  const work = useWorkSwitch();
  const notifications = useNotifications(runs.data, work.systemNotify);

  const pending = runs.data ? attentionCount(runs.data) : 0;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the title is worded in the language in use
  useEffect(() => {
    document.title = pageTitle(pending);
  }, [pending, language]);

  // A new page starts at the top (hash navigation keeps the scroll position otherwise), except
  // when it scrolls to a part of itself.
  const routeKey = JSON.stringify(route);
  const scrollsItself =
    (route.name === 'config' && route.template !== undefined) ||
    (route.name === 'guide' && route.section !== undefined);
  useEffect(() => {
    if (routeKey && !scrollsItself) window.scrollTo(0, 0);
  }, [routeKey, scrollsItself]);

  const configProblems = Object.keys(config.data?.errors ?? {}).length;

  return (
    <div className="app">
      <header className="topbar">
        <a className="brand" href={href.home}>
          {brandName()}
        </a>
        <nav>
          <NavLink to={href.home} active={route.name === 'home'}>
            {t({ zh: '首页', en: 'Home' })}
            {pending > 0 && <span className="count">{pending}</span>}
          </NavLink>
          <NavLink to={href.issues} active={route.name === 'issues'}>
            {t({ zh: '需求', en: 'Issues' })}
          </NavLink>
          <NavLink
            to={href.iterations}
            active={route.name === 'iterations' || route.name === 'iteration'}
          >
            {t({ zh: '迭代', en: 'Iterations' })}
          </NavLink>
          <NavLink to={href.stats} active={route.name === 'stats'}>
            {t({ zh: '统计', en: 'Stats' })}
          </NavLink>
          <NavLink to={href.agents} active={route.name === 'agents'}>
            Agent
          </NavLink>
          <NavLink to={href.events} active={route.name === 'events'}>
            {t({ zh: '事件', en: 'Events' })}
          </NavLink>
          <NavLink to={href.workspaces} active={route.name === 'workspaces'}>
            {t({ zh: '工作区', en: 'Workspaces' })}
          </NavLink>
          <NavLink to={href.repos} active={route.name === 'repos'}>
            {t({ zh: '仓库', en: 'Repos' })}
          </NavLink>
          <NavLink to={href.config} active={route.name === 'config'}>
            {t({ zh: '配置', en: 'Config' })}
          </NavLink>
          <NavLink to={href.guide} active={route.name === 'guide'}>
            {t({ zh: '说明', en: 'Guide' })}
          </NavLink>
        </nav>
        <WorkToggle work={work} />
        <NotifyToggle notifications={notifications} webhook={work.webhookNotify} />
        <LangToggle
          language={language}
          onSwitch={(l) => {
            storeLang(l);
            switchLang(l);
          }}
        />
        <span className={connected ? 'conn conn-ok' : 'conn conn-down'}>
          {connected
            ? t({ zh: '已连接', en: 'Connected' })
            : t({ zh: '连接断开，正在重试…', en: 'Disconnected, retrying…' })}
        </span>
      </header>
      <main key={language}>
        <WorkOffBanner work={work} />
        <NotifyBanner notifications={notifications} webhook={work.webhookNotify} />
        {config.data?.reloadError && (
          <ErrorBox>
            {t({
              zh: `配置文件有错误，重新加载失败（${formatTime(config.data.reloadError.at)}），仍在使用上一份有效配置：`,
              en: `The configuration files have errors and could not be reloaded (${formatTime(config.data.reloadError.at)}); the last valid configuration is still in use: `,
            })}
            {config.data.reloadError.message}
          </ErrorBox>
        )}
        {config.data && config.data.restartNeeded.length > 0 && (
          <div className="notice-banner">
            <span>
              {t({
                zh: `${join(config.data.restartNeeded)}的修改要重启 Master 才生效。`,
                en: `Changes to ${join(config.data.restartNeeded)} take effect after the Master restarts.`,
              })}
            </span>
          </div>
        )}
        {configProblems > 0 && route.name !== 'config' && (
          <ErrorBox>
            {t({
              zh: (
                <>
                  有 {configProblems} 项配置无效，已停用（<a href={href.config}>查看配置</a>）：
                </>
              ),
              en: (
                <>
                  {configProblems} configuration {configProblems === 1 ? 'item is' : 'items are'}{' '}
                  invalid and disabled (<a href={href.config}>see the configuration</a>):
                </>
              ),
            })}
            {Object.entries(config.data?.errors ?? {}).map(([key, errs]) => (
              <div key={key}>
                {key}
                {t({ zh: '：', en: ': ' })}
                {errs.join(t({ zh: '；', en: '; ' }))}
              </div>
            ))}
          </ErrorBox>
        )}
        <Page
          route={route}
          runs={runs}
          repos={repos}
          config={config.data}
          configError={config.data ? undefined : config.error}
          onReposChanged={() => {
            repos.reload();
            // The templates a repo keeps follow its target branch, read again by then.
            config.reload();
          }}
        />
      </main>
    </div>
  );
}

/** Switch the dashboard's language; the choice is remembered in this browser. */
function LangToggle(props: { language: Lang; onSwitch: (l: Lang) => void }) {
  const other: Lang = props.language === 'zh' ? 'en' : 'zh';
  return (
    <button
      type="button"
      className="lang-toggle"
      lang={other === 'zh' ? 'zh-CN' : 'en'}
      title={t({ zh: 'Switch to English', en: '切换到中文' })}
      onClick={() => props.onSwitch(other)}
    >
      {LANG_NAMES[other]}
    </button>
  );
}

function NavLink(props: { to: string; active: boolean; children: ReactNode }) {
  return (
    <a href={props.to} className={props.active ? 'active' : undefined}>
      {props.children}
    </a>
  );
}

function Page(props: {
  route: Route;
  runs: Resource<RunSummary[]>;
  repos: Resource<Repo[]>;
  config: ConfigView | undefined;
  configError: string | undefined;
  onReposChanged: () => void;
}) {
  const { route, runs, repos } = props;
  if (route.name === 'issues') return <IssuesPage config={props.config} />;
  if (route.name === 'iterations') return <IterationsPage />;
  if (route.name === 'iteration') return <IterationsPage id={route.id} />;
  if (route.name === 'workspaces') return <WorkspacesPage />;
  if (route.name === 'agents') return <AgentsPage />;
  if (route.name === 'events') return <EventsPage />;
  if (route.name === 'config')
    return <ConfigPage config={props.config} error={props.configError} target={route.template} />;
  if (route.name === 'guide')
    return (
      <GuidePage
        config={props.config}
        configError={props.configError}
        repos={repos.data}
        runs={runs.data}
        section={route.section}
      />
    );
  if (route.name === 'run')
    return (
      <RunDetailPage
        key={route.id}
        id={route.id}
        config={props.config}
        configError={props.configError}
      />
    );
  const error = runs.error ?? repos.error;
  if (!runs.data || !repos.data) {
    return error ? (
      <ErrorBox>{error}</ErrorBox>
    ) : (
      <Empty>{t({ zh: '加载中…', en: 'Loading…' })}</Empty>
    );
  }
  switch (route.name) {
    case 'home':
      return (
        <HomePage runs={runs.data} repos={repos.data} maxRuns={props.config?.maxRuns ?? null} />
      );
    case 'stats':
      return <StatsPage repos={repos.data} />;
    case 'repos':
      return (
        <ReposPage repos={repos.data} config={props.config} onChanged={props.onReposChanged} />
      );
    case 'notFound':
      return (
        <Empty>
          {t({ zh: `没有这个页面：${route.path}。`, en: `No such page: ${route.path}. ` })}
          <a href={href.home}>{t({ zh: '回到首页', en: 'Back to home' })}</a>
        </Empty>
      );
  }
}
