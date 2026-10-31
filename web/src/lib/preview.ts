import { useEffect, useMemo, useState } from 'react'
import { api, ApiError, type Asset, type SignedURL } from './api'
import { message } from './messages'

type Preview = { src: string; poster: string; storyboard: string; sprite: string; at: (file: string) => string }
const files = (base: string, token = ''): Preview => {
  // Any file beside the video, its own options first: at('thumbnail.webp?time=3&width=320').
  const at = (file: string) => `${base}/${file}${token ? `${file.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}` : ''}`
  return { src: at('playlist.m3u8'), poster: at('poster.webp'), storyboard: at('storyboard.vtt'), sprite: at('storyboard.jpg'), at }
}

/** Where the console previews a video: a public one at its own address, a private one under an hour's signature. */
export function usePreview(asset: Asset | undefined) {
  const [preview, setPreview] = useState<Preview | null>(null)
  const [problem, setProblem] = useState('')
  const [noKey, setNoKey] = useState(false)
  const playable = !!asset && !asset.deleted_at && (asset.status === 'ready' || asset.status === 'complete')
  const id = playable ? asset.id : ''
  const policy = asset?.playback_policy
  const embed = asset?.embed_url ?? ''
  useEffect(() => {
    setPreview(null)
    setProblem('')
    setNoKey(false)
    if (!id) return
    if (policy === 'public') return setPreview(files(embed))
    let live = true
    api<SignedURL>('POST', '/v1/signed-urls', { video_id: id, expires_in: 3600 })
      .then((s) => live && setPreview(files(embed, s.signature)))
      .catch((err) => {
        if (!live) return
        const missing = err instanceof ApiError && err.code === 'no_signing_key'
        setNoKey(missing)
        setProblem(missing ? 'This video is private, so it needs a signing key to preview.' : message(err))
      })
    return () => {
      live = false
    }
  }, [id, policy, embed])
  // The thumbnail changes when someone picks another; the version skips the five minutes browsers keep the old one.
  const version = asset ? encodeURIComponent(asset.updated_at) : ''
  const shown = useMemo(() => (preview ? { ...preview, poster: preview.at(`poster.webp?v=${version}`) } : null), [preview, version])
  return { preview: shown, problem, noKey, playable }
}
