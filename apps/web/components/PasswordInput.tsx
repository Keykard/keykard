'use client'
import { useState, type InputHTMLAttributes, type Ref } from 'react'

/** Password field with a show/hide toggle. Keeps every native input attribute (id, autoComplete…). */
export function PasswordInput({ style, ref, ...p }: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & { ref?: Ref<HTMLInputElement> }) {
  const [shown, setShown] = useState(false)
  return (
    <span className="pw-wrap" style={style}>
      <input {...p} ref={ref} type={shown ? 'text' : 'password'} />
      <button
        type="button"
        className="pw-toggle"
        aria-label={shown ? 'Hide password' : 'Show password'}
        aria-pressed={shown}
        onClick={() => setShown((v) => !v)}
      >
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" />
          <circle cx="12" cy="12" r="3" />
          {shown && <path d="M4 4l16 16" />}
        </svg>
      </button>
    </span>
  )
}
