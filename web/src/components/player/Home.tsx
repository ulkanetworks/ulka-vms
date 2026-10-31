import { Logo } from '@/components/Logo'
import { Meta } from '@/components/Meta'
import { Section } from '@/components/Section'
import { Player } from '@/components/player/Player'
import { Button } from '@/components/ui/button'
import type { PlayerConfig } from '@/lib/api'
import { timecode } from '@/lib/format'
import { useGet } from '@/lib/query'
import { rules } from '@/lib/rules'

const FEATURES: [string, string][] = [
  ['Picks the quality for the connection', 'Starts fast and moves between qualities as the network changes, without stopping.'],
  ['Chapters, captions and previews', 'Jump to a chapter, turn on subtitles, and see a picture while moving along the timeline.'],
  ['Keyboard, touch and picture-in-picture', 'Space, arrows and numbers on a keyboard; double-tap to skip on a phone; keep watching in a corner.'],
  ['Fits any size', 'The same player works from a small embed on a phone up to full screen on a TV.'],
  ['Private videos stay private', 'A signed link plays only for the viewer it was made for, and only until it expires.'],
  ['Says what is wrong', 'When a video won\'t play, the playback check tests each step in your browser and tells you what to do.'],
]

/** The player host's home: a sample video in the player, what the player does, and the way to the playback check. */
export function PlayerHome() {
  const demo = rules.player_demo
  const config = useGet<PlayerConfig>(demo ? `/${demo}/config.json` : null)
  const c = config.data
  return (
    <main className="mx-auto grid max-w-5xl gap-8 px-4 py-8 sm:py-12">
      <Meta title="Ulka Player" description="The Ulka video player: adaptive quality, chapters, captions and private links, in any website." />
      <header className="flex flex-wrap items-center justify-between gap-4">
        <Logo href="/" tag="Player" />
        <Button variant="outline" render={<a href="/check" />}>Playback check</Button>
      </header>

      {demo && (
        <section className="grid gap-4">
          <div className="aspect-video overflow-hidden rounded-xl bg-black">
            {c && <Player settings={c.settings} src={`/${demo}/${c.stream}`} poster={`/${demo}/${c.poster}`} storyboard={`/${demo}/${c.storyboard}`} chapters={c.chapters} check={`/check/${demo}`} fill />}
          </div>
          {c && (
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <h1 className="font-semibold text-xl">{c.title || 'Sample video'}</h1>
              <p className="text-muted-foreground text-sm">
                {c.duration_seconds ? timecode(c.duration_seconds) : ''}
                {c.chapters.length ? ` · ${c.chapters.length} chapters` : ''}
              </p>
            </div>
          )}
          {config.error && <p className="text-muted-foreground text-sm">The sample video couldn't be loaded. The playback check can tell you why.</p>}
        </section>
      )}

      <Section title="Ulka Player" description="What every video plays in, on its own page or embedded in a website.">
        <dl className="grid gap-x-8 gap-y-5 sm:grid-cols-2">
          {FEATURES.map(([title, text]) => (
            <div key={title} className="grid gap-1">
              <dt className="font-medium">{title}</dt>
              <dd className="text-muted-foreground text-sm">{text}</dd>
            </div>
          ))}
        </dl>
      </Section>

      <Section
        title="Trouble watching a video?"
        description="Paste its address into the playback check: it tests each step your browser takes and says in plain words what to fix."
        action={<Button render={<a href="/check" />}>Run a check</Button>}
      />
    </main>
  )
}
