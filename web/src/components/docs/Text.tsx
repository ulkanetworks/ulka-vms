// The spec's descriptions: paragraphs, and `code` in backticks. Nothing else needs formatting.
export function Text({ text = '', className }: { text?: string; className?: string }) {
  return (
    <>
      {text.split('\n\n').map((p, i) => (
        <p key={i} className={className}>
          {p.split(/`([^`]+)`/).map((part, j) => (j % 2 ? <code key={j}>{part}</code> : part))}
        </p>
      ))}
    </>
  )
}
