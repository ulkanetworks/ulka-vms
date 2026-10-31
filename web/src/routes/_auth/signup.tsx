import { createFileRoute } from '@tanstack/react-router'
import { AuthForm } from '@/components/AuthForm'
import { Meta } from '@/components/Meta'

export const Route = createFileRoute('/_auth/signup')({
  component: () => (
    <>
      <Meta title="Create your account" description="Create an Ulka VMS account for video hosting." />
      <AuthForm mode="signup" />
    </>
  ),
})
