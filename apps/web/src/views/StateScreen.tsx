import type { ReactNode } from 'react';
import { Play } from 'lucide-react';
import s from './Screens.module.css';

export function StateScreen({ icon, title, text, action }: { icon: ReactNode; title: string; text: string; action?: ReactNode }) {
  return (
    <div className={s.screen}>
      <div className={s.card}>
        <div className={s.brand}><span className={s.logo}><Play size={13} fill="currentColor" /></span> Watchroom</div>
        <div className={s.center}>
          <div className={s.bigIcon}>{icon}</div>
          <div className={s.title}>{title}</div>
          <div className={s.text}>{text}</div>
          {action}
        </div>
      </div>
    </div>
  );
}
