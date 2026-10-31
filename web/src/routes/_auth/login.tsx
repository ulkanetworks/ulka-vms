import { createFileRoute } from '@tanstack/react-router'
import { AuthForm } from '@/components/AuthForm'
import { Meta } from '@/components/Meta'

export const Route = createFileRoute('/_auth/login')({
  component: () => (
    <>
      <Meta title="Sign in" description="Sign in to manage your video, CDN and account." />
      <AuthForm mode="login" />
    </>
  ),
})
