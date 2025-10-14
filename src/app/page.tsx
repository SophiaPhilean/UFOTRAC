// src/app/page.tsx
import ClientPage from './ClientPage';

export const dynamic = 'force-dynamic';
export const revalidate = 0; // prevent prerender; page renders on each request

export default function Page() {
  return <ClientPage />;
}
