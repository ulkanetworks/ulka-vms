import { Outlet, createFileRoute } from '@tanstack/react-router'
import { AuthShell } from '@/components/AuthShell'

export const Route = createFileRoute('/_auth')({
  component: () => (
    <AuthShell>
      <Outlet />
    </AuthShell>
  ),
})
