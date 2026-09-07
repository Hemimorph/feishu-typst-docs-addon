import { useEffect } from 'react';
import { docsApi } from '../feishu';

const applyTheme = (isDark: boolean) => {
  document.documentElement.dataset.theme = isDark ? 'dark' : 'light';
};

export const useFeishuTheme = () => {
  useEffect(() => {
    let alive = true;
    const onChange = (isDark: boolean) => {
      if (alive) applyTheme(isDark);
    };

    void docsApi.Env.DarkMode.getIsDarkMode().then(onChange);
    void docsApi.Env.DarkMode.onDarkModeChange(onChange);

    return () => {
      alive = false;
      void docsApi.Env.DarkMode.offDarkModeChange(onChange);
    };
  }, []);
};
