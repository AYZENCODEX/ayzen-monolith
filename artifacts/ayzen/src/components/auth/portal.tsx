import { forwardRef, useId } from "react";
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from "react";
import { Loader2 } from "lucide-react";
import "./portal.css";

/** Presentational building blocks for the sign-in portal. No auth logic here. */

type FieldProps = Omit<InputHTMLAttributes<HTMLInputElement>, "id"> & {
  label: string;
  hint?: ReactNode;
  error?: string | null;
  /** Rendered inside the field, right-aligned (e.g. the show/hide toggle). */
  trailing?: ReactNode;
  /** Optional right-aligned text in the label row (e.g. "Forgot password?"). */
  aside?: ReactNode;
};

export const Field = forwardRef<HTMLInputElement, FieldProps>(function Field(
  { label, hint, error, trailing, aside, className, ...input },
  ref,
) {
  const id = useId();
  const describedBy = [hint ? `${id}-hint` : "", error ? `${id}-err` : ""].filter(Boolean).join(" ") || undefined;
  return (
    <div className={`zp-field${error ? " is-invalid" : ""}${className ? " " + className : ""}`}>
      <div className="zp-field-row">
        <label htmlFor={id}>{label}</label>
        {aside}
      </div>
      <div className="zp-control">
        <input ref={ref} id={id} aria-invalid={error ? true : undefined} aria-describedby={describedBy} {...input} />
        {trailing}
      </div>
      {hint && <p id={`${id}-hint`} className="zp-hint">{hint}</p>}
      {error && <p id={`${id}-err`} className="zp-error" role="alert">{error}</p>}
    </div>
  );
});

/** Six-digit one-time code. Digits only; one input so autofill and paste work. */
export function CodeField({ label, value, onChange, autoFocus }: {
  label: string; value: string; onChange: (v: string) => void; autoFocus?: boolean;
}) {
  return (
    <Field
      label={label}
      className="zp-code"
      value={value}
      onChange={(e) => onChange(e.target.value.replace(/\D/g, "").slice(0, 6))}
      inputMode="numeric"
      autoComplete="one-time-code"
      pattern="[0-9]{6}"
      maxLength={6}
      placeholder="······"
      autoFocus={autoFocus}
      required
    />
  );
}

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "solid" | "ghost" | "text";
  busy?: boolean;
  block?: boolean;
  icon?: ReactNode;
};

export function Btn({ variant = "solid", busy, block, icon, children, className, disabled, ...rest }: BtnProps) {
  return (
    <button
      className={`zp-btn zp-${variant}${block ? " zp-block" : ""}${className ? " " + className : ""}`}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      {...rest}
    >
      {busy ? <Loader2 className="zp-spin" aria-hidden="true" /> : icon}
      <span>{children}</span>
    </button>
  );
}

export function Divider({ children }: { children: ReactNode }) {
  return <div className="zp-divider" role="separator"><span>{children}</span></div>;
}

export function Notice({ tone = "info", icon, title, children }: {
  tone?: "info" | "warn" | "ok"; icon?: ReactNode; title: string; children?: ReactNode;
}) {
  return (
    <div className={`zp-notice zp-notice-${tone}`}>
      {icon && <div className="zp-notice-icon" aria-hidden="true">{icon}</div>}
      <div>
        <p className="zp-notice-title">{title}</p>
        {children && <p className="zp-notice-body">{children}</p>}
      </div>
    </div>
  );
}

export function Heading({ title, sub }: { title: string; sub?: ReactNode }) {
  return (
    <header className="zp-heading">
      <h2>{title}</h2>
      {sub && <p>{sub}</p>}
    </header>
  );
}

/** Ordered steps of a multi-screen flow. Only used where the content really is a sequence. */
export function Stepper({ steps, current }: { steps: string[]; current: number }) {
  return (
    <nav className="zp-stepper" aria-label="Sign-up progress">
      <ol>
        {steps.map((label, i) => (
          <li key={label} className={i < current ? "is-done" : i === current ? "is-now" : ""} aria-current={i === current ? "step" : undefined}>
            <span className="zp-sr">{label}</span>
          </li>
        ))}
      </ol>
      <p>Step {current + 1} of {steps.length}: {steps[current]}</p>
    </nav>
  );
}
