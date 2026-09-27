import type { ButtonHTMLAttributes, ReactNode } from 'react';
import s from './Button.module.css';
import { LiveDot } from './LiveDot';

export type ButtonVariant = 'white' | 'light' | 'ink' | 'ghost' | 'soft' | 'red' | 'line';
export type ButtonSize = 'sm' | 'md' | 'lg';
/** `rect` = app controls (12 px radius), `pill` = landing. */
export type ButtonShape = 'rect' | 'pill';

export interface ButtonStyle {
  variant?: ButtonVariant;
  size?: ButtonSize;
  shape?: ButtonShape;
  block?: boolean;
  className?: string;
}

/** Class names for a button look, for links styled as buttons (`<Link className={buttonClass(...)}>`). */
export function buttonClass({
  variant = 'ink',
  size = 'md',
  shape = 'rect',
  block,
  className,
}: ButtonStyle = {}): string {
  return [s.btn, s[shape], s[size], s[variant], block && s.block, className]
    .filter(Boolean)
    .join(' ');
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, ButtonStyle {
  /** Leading red live dot ("Try a call"). */
  dot?: boolean;
  icon?: ReactNode;
}

export function Button({
  variant,
  size,
  shape,
  block,
  className,
  dot,
  icon,
  type = 'button',
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={buttonClass({ variant, size, shape, block, className })}
      {...rest}
    >
      {dot && <LiveDot />}
      {icon}
      {children}
    </button>
  );
}

export interface IconButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label'> {
  /** Accessible name; icon buttons have no visible text. */
  label: string;
  tone?: 'night' | 'paper';
  children: ReactNode;
}

/** 44 px square icon button (night) or round close button (paper). */
export function IconButton({
  label,
  tone = 'night',
  className,
  type = 'button',
  children,
  ...rest
}: IconButtonProps) {
  const cls = [s.icon, tone === 'paper' && s.iconPaper, className].filter(Boolean).join(' ');
  return (
    <button type={type} className={cls} aria-label={label} {...rest}>
      {children}
    </button>
  );
}
