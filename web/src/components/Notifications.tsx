import { t } from '../../../src/i18n.js';
import type { Notifications } from '../lib/notifications.js';

/** Offer to turn notifications on, or explain how to unblock them. */
export function NotifyBanner({ notifications }: { notifications: Notifications }) {
  const { state, enable, disable } = notifications;
  if (state === 'ask') {
    return (
      <div className="notice-banner">
        <span>
          {t({
            zh: '开启浏览器通知：需要你处理时（审批、Run 卡住或失败、提案等你决定）提醒你（看板开在后台标签页也可以）。',
            en: 'Turn on browser notifications to be told when you are needed (approvals, Runs blocked or failed, proposals awaiting your decision), even with the dashboard in a background tab.',
          })}
        </span>
        <button type="button" className="btn-primary" onClick={enable}>
          {t({ zh: '开启', en: 'Turn on' })}
        </button>
        <button type="button" onClick={disable}>
          {t({ zh: '不用了', en: 'No thanks' })}
        </button>
      </div>
    );
  }
  if (state === 'denied') {
    return (
      <div className="notice-banner">
        <span>
          {t({
            zh: '浏览器拒绝了通知权限。要开启：点地址栏左侧的站点信息图标，把「通知」改为「允许」，然后刷新页面。',
            en: 'The browser blocked notifications. To allow them, click the site information icon left of the address bar, set "Notifications" to "Allow", then reload the page.',
          })}
        </span>
        <button type="button" onClick={disable}>
          {t({ zh: '知道了', en: 'Got it' })}
        </button>
      </div>
    );
  }
  return null;
}

/** Small switch in the top bar. */
export function NotifyToggle({ notifications }: { notifications: Notifications }) {
  const { state, enable, disable } = notifications;
  if (state === 'unsupported') return null;
  if (state === 'system') {
    return (
      <span
        className="notify-toggle"
        title={t({
          zh: '需要你处理时，Master 会直接发系统通知（config.yaml 的 notify.system）',
          en: 'The Master sends system notifications itself when you are needed (notify.system in config.yaml)',
        })}
      >
        {t({ zh: '通知：系统', en: 'Notifications: system' })}
      </span>
    );
  }
  const on = state === 'on';
  return (
    <button
      type="button"
      className="notify-toggle"
      aria-pressed={on}
      title={
        on
          ? t({ zh: '点击关闭浏览器通知', en: 'Click to turn browser notifications off' })
          : t({ zh: '点击开启浏览器通知', en: 'Click to turn browser notifications on' })
      }
      onClick={on ? disable : enable}
    >
      {t({ zh: '通知：', en: 'Notifications: ' })}
      {on
        ? t({ zh: '开', en: 'on' })
        : state === 'denied'
          ? t({ zh: '被浏览器拒绝', en: 'blocked by the browser' })
          : t({ zh: '关', en: 'off' })}
    </button>
  );
}
