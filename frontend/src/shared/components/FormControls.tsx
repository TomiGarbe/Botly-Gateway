import { ChevronDown } from 'lucide-react'
import { cloneElement, forwardRef, useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactElement, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react'

function classes(...values: Array<string | undefined | null | false | 0>) { return values.filter(Boolean).join(' ') }

type FieldProps = {
  label: ReactNode
  description?: ReactNode
  error?: ReactNode
  optional?: boolean
  required?: boolean
  children: ReactElement
  className?: string
}

/** Associates a compact label, optional help text and validation message with one native control. */
export function Field({ label, description, error, optional = false, required = false, children, className }: FieldProps) {
  const generatedId = useId()
  const childProps = children.props as { id?: string; className?: string; 'aria-describedby'?: string; 'aria-invalid'?: boolean }
  const controlId = childProps.id || generatedId
  const descriptionId = description ? `${controlId}-description` : undefined
  const errorId = error ? `${controlId}-error` : undefined
  const describedBy = [childProps['aria-describedby'], descriptionId, errorId].filter(Boolean).join(' ') || undefined
  const control = { id: controlId, 'aria-describedby': describedBy, 'aria-invalid': error ? true : childProps['aria-invalid'] }
  return <div className={classes('ui-field', className)}>
    <label className="ui-field-label" htmlFor={controlId}>{label}{required ? <span className="ui-field-required" aria-hidden="true"> *</span> : null}{optional ? <span className="ui-field-optional">Opcional</span> : null}</label>
    {description ? <p id={descriptionId} className="ui-field-description">{description}</p> : null}
    {cloneElement(children, { ...control, className: classes(childProps.className, error && 'is-error') })}
    {error ? <p id={errorId} className="ui-field-error" role="alert">{error}</p> : null}
  </div>
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...props }, ref) {
  return <input ref={ref} className={classes('ui-control', 'ui-input', className)} {...props} />
})

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select({ className, children, ...props }, ref) {
  return <select ref={ref} className={classes('ui-control', 'ui-select', className)} {...props}>{children}</select>
})

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement> & { code?: boolean }>(function Textarea({ className, code = false, ...props }, ref) {
  return <textarea ref={ref} className={classes('ui-control', 'ui-textarea', code && 'ui-textarea-code', className)} {...props} />
})

export function RichSelect<T extends string>({ value, options, onChange, disabled = false, id, 'aria-describedby': describedBy, 'aria-invalid': invalid }: { value: T; options: Array<{ value: T; label: string; description?: string }>; onChange: (value: T) => void; disabled?: boolean; id?: string; 'aria-describedby'?: string; 'aria-invalid'?: boolean }) {
  const [isOpen, setIsOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const selected = options.find((option) => option.value === value) || options[0]
  useEffect(() => {
    const close = (event: MouseEvent) => { if (root.current && !root.current.contains(event.target as Node)) setIsOpen(false) }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [])
  function move(direction: 1 | -1) {
    const current = Math.max(0, options.findIndex((option) => option.value === value))
    onChange(options[(current + direction + options.length) % options.length].value)
  }
  if (!selected) return null
  return <div ref={root} className="ui-rich-select"><button id={id} type="button" className="ui-rich-select-trigger" aria-haspopup="listbox" aria-expanded={isOpen} aria-describedby={describedBy} aria-invalid={invalid} disabled={disabled} onClick={() => setIsOpen((open) => !open)} onKeyDown={(event) => { if (event.key === 'Escape') setIsOpen(false); if (event.key === 'ArrowDown') { event.preventDefault(); move(1) }; if (event.key === 'ArrowUp') { event.preventDefault(); move(-1) } }}>{selected.label}<ChevronDown size={16} aria-hidden="true" /></button>{isOpen ? <div className="ui-rich-select-menu" role="listbox" aria-label="Opciones"><>{options.map((option) => <button key={option.value} type="button" role="option" aria-selected={option.value === value} className={`ui-rich-select-option${option.value === value ? ' is-selected' : ''}`} onClick={() => { onChange(option.value); setIsOpen(false) }}><strong>{option.label}</strong>{option.description ? <small>{option.description}</small> : null}</button>)}</></div> : null}</div>
}

export function Checkbox({ label, description, className, ...props }: InputHTMLAttributes<HTMLInputElement> & { label: ReactNode; description?: ReactNode }) {
  const id = useId()
  return <label className={classes('ui-checkbox', className)} htmlFor={props.id || id}><input id={props.id || id} type="checkbox" {...props} /><span><strong>{label}</strong>{description ? <small>{description}</small> : null}</span></label>
}

export function Switch({ label, description, className, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { label: ReactNode; description?: ReactNode }) {
  const checked = props['aria-checked'] === true
  return <button {...props} type={props.type || 'button'} role="switch" className={classes('ui-switch', checked && 'is-enabled', className)}><span><strong>{label}</strong>{description ? <small>{description}</small> : null}</span><span className="ui-switch-track" aria-hidden="true"><span className="ui-switch-thumb" /></span></button>
}

export function Button({ variant = 'primary', className, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'ghost' | 'danger' }) {
  return <button {...props} className={classes(`ui-button-${variant}`, className)} />
}

export function IconButton({ className, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { 'aria-label': string }) {
  return <button {...props} className={classes('icon-button', className)} />
}
