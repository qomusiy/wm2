import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import s from './Button.module.css';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md' | 'lg';

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  block?: boolean;
  icon?: ReactNode;
  active?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, Props>(function Button(
  { variant = 'secondary', size = 'md', block, icon, active, className, children, type = 'button', ...rest }, ref,
) {
  const cls = [s.btn, s[variant], size !== 'md' && s[size], block && s.block, active && s.active, className].filter(Boolean).join(' ');
  return (
    <button ref={ref} type={type} className={cls} {...rest}>
      {icon}
      {children}
    </button>
  );
});

interface IconProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  variant?: Variant;
  size?: Size;
  active?: boolean;
}

export const IconButton = forwardRef<HTMLButtonElement, IconProps>(function IconButton(
  { label, variant = 'ghost', size = 'md', active, className, children, type = 'button', ...rest }, ref,
) {
  const cls = [s.btn, s.icon, s[variant], size !== 'md' && s[size], active && s.active, className].filter(Boolean).join(' ');
  return (
    <button ref={ref} type={type} className={cls} aria-label={label} title={label} {...rest}>
      {children}
    </button>
  );
});
