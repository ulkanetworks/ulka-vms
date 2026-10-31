import { createFileRoute } from '@tanstack/react-router'
import { Check } from '@/components/player/Check'
import { loadedToken } from '@/lib/address'
import { checkIds } from '@/lib/watch'

// The viewer check on the player host: /check/{library}/{video}?token=&ref= (the page the video was embedded on).
export const Route = createFileRoute('/check/$lib/$video')({
  validateSearch: (s: Record<string, unknown>) => ({ ...(typeof s.ref === 'string' && s.ref ? { ref: s.ref } : {}) }) as { ref?: string },
  beforeLoad: checkIds,
  component: Page,
})

function Page() {
  const { lib, video } = Route.useParams()
  return <Check lib={lib} video={video} token={loadedToken} ref={Route.useSearch().ref ?? ''} />
}
