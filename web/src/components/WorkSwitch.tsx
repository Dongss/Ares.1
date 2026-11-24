import { useEffect, useRef } from 'react';
import { t } from '../../../src/i18n.js';
import { api } from '../lib/api.js';
import { useAction, useReloadOn, useResource } from '../lib/hooks.js';

/** The work switch: off = queued Runs wait, no issues are taken, no automatic scouts. */
export function useWorkSwitch() {
  const health = useResource(() => api.health(), 'health');
  // A reloaded config.yaml may have changed how notifications are sent.
  useReloadOn(health.reload, (e) => e.type === 'master.working' || e.type === 'config.reloaded');
  // After the Master upgraded itself this page is outdated: load the new one.
  const firstVersion = useRef<string | null | undefined>(undefined);
  const version = health.data?.version;
  useEffect(() => {
    if (version === undefined) return;
    if (firstVersion.current === undefined) firstVersion.current = version;
    else if (version !== firstVersion.current) window.location.reload();
  }, [version]);
  const action = useAction();
  const set = async (on: boolean) => {
    if ((await action.run(() => api.setWorking(on))) !== undefined) health.reload();
  };
  return {
    working: health.data?.working,
    systemNotify: health.data?.systemNotify ?? false,
    webhookNotify: health.data?.webhookNotify ?? false,
    busy: action.busy,
    error: action.error,
    set,
  };
}

export type WorkSwitch = ReturnType<typeof useWorkSwitch>;

export function WorkToggle({ work }: { work: WorkSwitch }) {
  if (work.working === undefined) return null;
  return (
    <button
      type="button"
      className={work.working ? 'work-toggle work-on' : 'work-toggle work-off'}
      disabled={work.busy}
      title={
        work.working
          ? t({ zh: '点击关闭：不再开始新的工作', en: 'Click to turn off: no new work is started' })
          : t({
              zh: '点击打开：继续执行排队的 Run、接活、侦察',
              en: 'Click to turn on: resume queued Runs, taking issues and scouting',
            })
      }
      onClick={() => void work.set(!work.working)}
    >
      {work.working ? t({ zh: '工作中', en: 'Working' }) : t({ zh: '已停工', en: 'Stopped' })}
    </button>
  );
}

export function WorkOffBanner({ work }: { work: WorkSwitch }) {
  if (work.working !== false && !work.error) return null;
  return (
    <div className="notice-banner">
      <span>
        {work.error
          ? t({
              zh: `切换工作开关失败：${work.error}`,
              en: `Switching work on or off failed: ${work.error}`,
            })
          : t({
              zh: '已停工：排队的 Run 不会开始，也不会从 GitHub 接活或自动侦察。正在执行的 Run 都会做完，想立刻停下哪个就暂停哪个。',
              en: 'Stopped: queued Runs do not start, and no issues are taken from GitHub or scouted automatically. Running Runs finish; pause one to stop it right away.',
            })}
      </span>
      {work.working === false && (
        <button
          type="button"
          className="btn-primary"
          disabled={work.busy}
          onClick={() => void work.set(true)}
        >
          {t({ zh: '开工', en: 'Start working' })}
        </button>
      )}
    </div>
  );
}
