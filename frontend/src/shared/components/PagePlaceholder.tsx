export function PagePlaceholder({ title, description, detail }: { title: string; description: string; detail?: string }) {
  return (
    <section className="page-placeholder">
      <p className="page-placeholder-eyebrow">Botly Gateway</p>
      <h2>{title}</h2>
      <p>{description}</p>
      {detail ? <span>{detail}</span> : null}
    </section>
  )
}
