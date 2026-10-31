import { useLoaderData } from '@tanstack/react-router'

/** The signed-in person's workspace, role and permissions; loaded by the `_app` layout. */
export const useMe = () => useLoaderData({ from: '/_app' }).me
