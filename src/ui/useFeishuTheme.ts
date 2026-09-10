import { useEffect } from 'react';
import { docsApi } from '../feishu';

const applyTheme = (isDark: boolean) => {
  document.documentElement.dataset.theme = isDark ? 'dark' : 'light';
};

export const useFeishuTheme = () => {
  useEffect(() => {
    let alive = true;
    let subscribed = false;
    const onChange = (isDark: boolean) => {
      if (alive) applyTheme(isDark);
    };
    const unsubscribe = async () => {
      if (!subscribed) return;
      subscribed = false;
      try {
        await docsApi.Env.DarkMode.offDarkModeChange(onChange);
      } catch (reason) {
        console.info('取消飞书深色模式监听失败', reason);
      }
    };

    void (async () => {
      try {
        onChange(await docsApi.Env.DarkMode.getIsDarkMode());
      } catch (reason) {
        console.info('读取飞书深色模式失败，继续使用浅色主题', reason);
      }

      if (!alive) return;
      try {
        await docsApi.Env.DarkMode.onDarkModeChange(onChange);
        subscribed = true;
        if (!alive) await unsubscribe();
      } catch (reason) {
        if (alive) console.info('监听飞书深色模式失败', reason);
      }
    })();

    return () => {
      alive = false;
      void unsubscribe();
    };
  }, []);
};
