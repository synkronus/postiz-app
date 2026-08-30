'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useVariables } from '@gitroom/react/helpers/variable.context';
import { setCookie } from '@gitroom/frontend/components/layout/layout.context';
import { useT } from '@gitroom/react/translation/get.transation.service.client';

// Konversify SSO handoff: the shell opens /sso#t=<jwt> and this page exchanges
// the token for a Postiz session. The token lives in the URL fragment only and
// is stripped from the URL/history as soon as it is read — it is never placed
// in a query string, a log, or the console.
//
// The request deliberately bypasses useFetch: its global afterRequest hook
// redirects to "/" on any 401, which would swallow the failure screen below.
export function Sso() {
  const t = useT();
  const { backendUrl, isSecured } = useVariables();
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

      const request = await fetch(`${backendUrl}/integrations/konversify-sso`, {
        method: 'POST',
        ...(isSecured ? { credentials: 'include' as const } : {}),
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ token }),
      });

      if (request.status === 200) {
        // unsecured deployments expose the session via headers instead of a
        // cookie readable across origins (same fallback as the login page)
        if (!isSecured) {
          const auth = request.headers.get('auth');
          const showorg = request.headers.get('showorg');
          if (auth) {
            setCookie('auth', auth, 365);
          }
          if (showorg) {
            setCookie('showorg', showorg, 365);
          }
        }
        window.location.replace('/');
        return;
      }

      setFailed(true);
    };

    exchangeToken().catch((err) => {
      console.error('sso token exchange failed', err);
      setFailed(true);
    });
  }, [backendUrl, isSecured]);

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
