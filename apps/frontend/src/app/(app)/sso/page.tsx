export const dynamic = 'force-dynamic';
import { Sso } from '@gitroom/frontend/components/auth/sso';
import { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Signing in',
  description: '',
};

export default async function SsoPage() {
  return <Sso />;
}
