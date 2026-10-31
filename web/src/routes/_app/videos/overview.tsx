import { createFileRoute, redirect } from '@tanstack/react-router'

// The library page now carries the counts; the old address still works.
export const Route = createFileRoute('/_app/videos/overview')({
  beforeLoad: () => {
    throw redirect({ to: '/videos', statusCode: 308 })
  },
})
