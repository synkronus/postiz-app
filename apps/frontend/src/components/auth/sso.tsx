'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { useT } from '@gitroom/react/translation/get.transation.service.client';

// Konversify SSO handoff: the shell opens /sso#t=<jwt> and this page exchanges
// the token for a Postiz session. The token lives in the URL fragment only and
// is stripped from the URL/history as soon as it is read — it is never placed
// in a query string, a request header log, or the console.
export function Sso() {
  const t = useT();
  const fetchData = useFetch();
  const [failed, setFailed] = useState(false);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) {
      return;
    }
    started.current = true;

    const exchangeToken = async () => {
      const token = new URLSearchParams(
        window.location.hash.replace(/^#/, '')
      ).get('t');

      if (!token) {
        setFailed(true);
        return;
      }

      window.history.replaceState(null, '', window.location.pathname);

      const request = await fetchData('/integrations/konversify-sso', {
        method: 'POST',
        body: JSON.stringify({ token }),
      });

      if (request.status === 200) {
        window.location.replace('/');
        return;
      }

      setFailed(true);
    };

    exchangeToken();
  }, [fetchData]);

  return (
    <div className="bg-[#0E0E0E] flex flex-col items-center justify-center min-h-screen w-screen text-white p-[24px]">
      {failed ? (
        <div className="flex flex-col items-center gap-[16px] max-w-[440px] text-center">
          <h1 className="text-[28px] font-[500]">
            {t('sso_failed', 'Sign-in link is invalid or expired')}
          </h1>
          <p className="text-[14px] text-[#B3B3B3]">
            {t(
              'sso_failed_description',
              'Please go back to Konversify and open the tool again, or sign in with your email and password.'
            )}
          </p>
          <Link href="/auth/login" className="underline hover:font-bold">
            {t('sign_in_1', 'Sign in')}
          </Link>
        </div>
      ) : (
        <h1 className="text-[20px] font-[500]">
          {t('sso_signing_in', 'Signing you in…')}
        </h1>
      )}
    </div>
  );
}
