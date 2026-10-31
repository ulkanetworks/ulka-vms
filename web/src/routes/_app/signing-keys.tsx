import { createFileRoute, redirect } from '@tanstack/react-router'

// Video signing keys live under Video again; old links still land there.
export const Route = createFileRoute('/_app/signing-keys')({
  beforeLoad: () => {
    throw redirect({ to: '/videos/signing-keys', statusCode: 308 })
  },
})
