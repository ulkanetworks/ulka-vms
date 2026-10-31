import { createFileRoute, redirect } from '@tanstack/react-router'

// Delivery now sits on the Video defaults page; old links land there.
export const Route = createFileRoute('/_app/videos/delivery')({
  beforeLoad: () => {
    throw redirect({ to: '/videos/defaults', search: { tab: 'delivery' }, statusCode: 308 })
  },
})
