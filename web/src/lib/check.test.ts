import { describe, expect, it } from 'vitest'
import { browserName, browserStep, clockStep, findingSteps, firstVariant, qualities, renditionParts, systemName, verdict, type CheckInfo } from './check'

const base = 'https://player.ulka.co/l/v/'

describe('viewer check', () => {
  it('reads a master and a quality playlist', () => {
    expect(firstVariant('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\n720p.m3u8?token=a\n', base)).toBe(base + '720p.m3u8?token=a')
    const r = renditionParts(
      '#EXTM3U\n#EXT-X-MAP:URI="https://o.example/x/720p/init.mp4"\n#EXT-X-KEY:METHOD=AES-128,URI="https://b.securedrm.link/v1/key/v?token=t",IV=0x000102030405060708090a0b0c0d0e0f\n#EXTINF:4.0,\nhttps://o.example/x/720p/1.m4s\n',
      base + '720p.m3u8',
    )
    expect(r.key).toBe('https://b.securedrm.link/v1/key/v?token=t')
    expect(r.init).toBe('https://o.example/x/720p/init.mp4')
    expect(r.segment).toBe('https://o.example/x/720p/1.m4s')
    expect(Array.from(r.iv!)).toEqual([...Array(16).keys()])
    expect(renditionParts('#EXT-X-KEY:METHOD=AES-128,URI="key?token=a"\n1.m4s\n', base + 'q.m3u8').key).toBe(base + 'key?token=a')
  })

  it('judges the clock', () => {
    expect(clockStep(5_000).state).toBe('ok')
    expect(clockStep(60_000).state).toBe('note')
    expect(clockStep(10 * 60_000)).toMatchObject({ state: 'problem' })
    expect(clockStep(-10 * 60_000).value).toContain('ahead')
  })

  it("words the server's findings for the viewer, keeping its own words", () => {
    const info: CheckInfo = {
      server_time: '', viewer: { ip: '', country: '' }, status: 'complete', plays: false,
      findings: [
        { kind: 'signature', state: 'ok', message: 'genuine' },
        { kind: 'expiry', state: 'problem', message: 'It has expired' },
        { kind: 'country', state: 'problem', message: 'country refused' },
      ],
    }
    const [link, access, video] = findingSteps(info)
    expect(link).toMatchObject({ state: 'problem', cause: 'It has expired' })
    expect(link.detail).toContain('expired')
    expect(access.detail).toContain('country')
    expect(video.state).toBe('ok')
  })

  it('judges the browser', () => {
    const yes = { MediaSource: { isTypeSupported: () => true } } as never
    const no = { MediaSource: { isTypeSupported: () => false } } as never
    expect(browserStep(yes, false).state).toBe('ok')
    expect(browserStep(no, true).state).toBe('ok')
    expect(browserStep(no, false).state).toBe('problem')
  })

  it('leads with the first problem', () => {
    expect(verdict([{ id: 'clock', state: 'ok' }]).ok).toBe(true)
    const v = verdict([{ id: 'clock', state: 'ok' }, { id: 'key', state: 'problem', detail: 'blocked' }, { id: 'data', state: 'problem' }])
    expect(v).toMatchObject({ ok: false, action: 'blocked' })
  })

  it('names the browser, system and qualities', () => {
    const mac = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15'
    const edge = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36 Edg/141.0'
    const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0 Mobile/15E148 Safari/604.1'
    expect(browserName(mac)).toBe('Safari 18')
    expect(browserName(edge)).toBe('Edge 141')
    expect(browserName(iphone)).toBe('Chrome 141')
    expect(browserName('', { brands: [{ brand: 'Not)A;Brand', version: '99' }, { brand: 'Google Chrome', version: '141' }] })).toBe('Google Chrome 141')
    expect(systemName(mac)).toBe('macOS')
    expect(systemName(iphone)).toBe('iOS')
    expect(systemName(edge, { platform: 'Windows' })).toBe('Windows')
    expect(qualities('#EXT-X-STREAM-INF:RESOLUTION=640x360\n#EXT-X-STREAM-INF:RESOLUTION=1280x720\n#EXT-X-STREAM-INF:RESOLUTION=1280x720')).toBe('720p, 360p')
  })
})
