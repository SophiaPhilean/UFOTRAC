// src/app/page.tsx
export const dynamic = 'force-dynamic';
export const revalidate = false; // always render at request time (no stale SSR)

import ClientPage from './ClientPage';

export default function Page() {
  return <ClientPage />;
}

