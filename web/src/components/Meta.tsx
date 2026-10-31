// Page title and the tags crawlers and link previews read. React 19 moves these into <head>.
export function Meta({ title, description }: { title: string; description: string }) {
  const full = `${title} · Ulka VMS.`
  return (
    <>
      <title>{full}</title>
      <meta name="description" content={description} />
      <meta property="og:title" content={full} />
      <meta property="og:description" content={description} />
      <meta property="og:type" content="website" />
      <meta property="og:distribution_name" content="Ulka VMS" />
      <meta name="twitter:card" content="summary" />
    </>
  )
}
