import { createFileRoute, redirect } from '@tanstack/react-router'

// Creating a key is a dialog on the list now; the old address still works.
export const Route = createFileRoute('/_app/api-keys/new')({
  beforeLoad: () => {
    throw redirect({ href: '/api-keys?new=1', statusCode: 308 })
  },
})
