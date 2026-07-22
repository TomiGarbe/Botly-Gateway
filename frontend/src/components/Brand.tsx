type Props = {
  compact?: boolean
  className?: string
}

export default function Brand({ compact = false, className = '' }: Props) {
  return (
    <span className={`inline-flex items-center gap-2.5 min-w-0 ${className}`} aria-label="Botly Gateway">
      <img src="/logo-gateway-mark.svg" alt="" aria-hidden="true" className="size-7 shrink-0" />
      {!compact && (
        <span className="font-semibold text-sm tracking-tight truncate">
          Botly <span className="text-zinc-500 font-medium">Gateway</span>
        </span>
      )}
    </span>
  )
}
