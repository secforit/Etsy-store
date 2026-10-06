'use client';

import type { MouseEvent, ReactNode } from 'react';
import { useFormStatus } from 'react-dom';

export function SubmitButton({
  children,
  className = 'btn btn-primary',
  pendingText = 'Working…',
  confirmText,
  name,
  value,
}: {
  children: ReactNode;
  className?: string;
  pendingText?: string;
  /** When set, asks for confirmation before submitting. */
  confirmText?: string;
  name?: string;
  value?: string;
}) {
  const { pending } = useFormStatus();
  const onClick = (e: MouseEvent<HTMLButtonElement>) => {
    if (confirmText && !window.confirm(confirmText)) e.preventDefault();
  };
  return (
    <button type="submit" className={className} disabled={pending} onClick={onClick} name={name} value={value}>
      {pending ? pendingText : children}
    </button>
  );
}
