import { afterEach, describe, expect, it } from 'vitest'
import { crossHost, loadRules, rules } from './rules'

const at = (origin: string) => Object.assign(globalThis, { location: { origin } })

describe('crossHost', () => {
  afterEach(() => loadRules({ ...rules, docs_url: '', console_url: '' }))

  it('sends docs links to the docs host and back again', () => {
    loadRules({ ...rules, docs_url: 'https://docs.ulka.co', console_url: 'https://console.ulka.co' })
    at('https://console.ulka.co')
    expect(crossHost('/docs/guides/play-video#private-videos')).toBe('https://docs.ulka.co/docs/guides/play-video#private-videos')
    expect(crossHost('/changelog')).toBe('https://docs.ulka.co/changelog')
    expect(crossHost('/videos')).toBe('/videos')
    expect(crossHost('/docsy')).toBe('/docsy')
    at('https://docs.ulka.co')
    expect(crossHost('/docs/api?s=videos')).toBe('/docs/api?s=videos')
    expect(crossHost('/')).toBe('https://console.ulka.co/')
  })

  it('leaves links alone when one host serves both (development)', () => {
    loadRules({ ...rules, docs_url: 'http://localhost:5173', console_url: 'http://localhost:5173' })
    at('http://localhost:5173')
    expect(crossHost('/docs')).toBe('/docs')
    expect(crossHost('/')).toBe('/')
  })
})
