import {
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { User } from '@prisma/client';
import { AuthService } from '@gitroom/helpers/auth/auth.service';
import { KonversifySsoRepository } from './konversify.sso.repository';

export interface KonversifySsoClaims {
  sub: string;
  email: string;
  workspaceId: string;
  role: string;
}

export interface KonversifySsoSession {
  jwt: string;
  organizationId: string;
}

@Injectable()
export class KonversifySsoService {
  // one remote JWKS per URL, cached for the process lifetime; jose refreshes
  // keys itself on rotation (cache + cooldown are handled internally)
  private readonly _jwksByURL = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

  constructor(private _konversifySsoRepository: KonversifySsoRepository) {}

  isEnabled() {
    return process.env.KONVERSIFY_SSO_ENABLED === 'true';
  }

  async loginWithToken(
    token: string,
    ip: string,
    userAgent: string
  ): Promise<KonversifySsoSession> {
    const claims = await this.verifyToken(token);

    const [user, organization] = await Promise.all([
      this._konversifySsoRepository.ensureUser(claims, ip, userAgent),
      this._konversifySsoRepository.ensureOrganization(claims.workspaceId),
    ]);

    await this._konversifySsoRepository.ensureMembership(
      user.id,
      organization.id,
      claims.role,
    );

    return { jwt: this.sessionJWT(user), organizationId: organization.id };
  }

  // same signing path as the login flow: HS256 JWT of the user row
  private sessionJWT(user: User) {
    const { password, ...safeUser } = user;
    return AuthService.signJWT(safeUser);
  }

  private async verifyToken(token: string): Promise<KonversifySsoClaims> {
    const jwksUrl = process.env.KONVERSIFY_JWKS_URL;
    const issuer = process.env.KONVERSIFY_SSO_ISSUER;
    const audience = process.env.KONVERSIFY_SSO_AUDIENCE;
    // jose skips claim checks for undefined options — a half-configured
    // deployment must reject tokens, not accept them unchecked
    if (!jwksUrl || !issuer || !audience) {
      new Logger(KonversifySsoService.name).warn(
        'konversify sso rejected: not_configured'
      );
      throw new ServiceUnavailableException('Konversify SSO is unavailable');
    }

    try {
      const { payload } = await jwtVerify(token, this.getJWKS(jwksUrl), {
        issuer,
        audience,
        algorithms: ['ES256'],
      });

      const claims = payload as unknown as KonversifySsoClaims;
      if (
        typeof claims.email !== 'string' ||
        !claims.email ||
        typeof claims.workspaceId !== 'string' ||
        !claims.workspaceId
      ) {
        throw new Error('missing claims');
      }

      return claims;
    } catch (err) {
      // one classified warn line so a JWKS outage or key-rotation gap is
      // distinguishable from token noise in the logs; only the error class
      // is logged — jose messages embed received claim values
      const reason = rejectReason(err);
      new Logger(KonversifySsoService.name).warn(
        `konversify sso rejected: ${reason}`
      );

      if (reason === 'jwks_unreachable') {
        throw new ServiceUnavailableException('Konversify SSO is unavailable');
      }
      throw new UnauthorizedException();
    }
  }

  private getJWKS(url: string) {
    let jwks = this._jwksByURL.get(url);
    if (!jwks) {
      jwks = createRemoteJWKSet(new URL(url));
      this._jwksByURL.set(url, jwks);
    }
    return jwks;
  }
}

const errorCode = (err: unknown): string | undefined => {
  const code = (err as { code?: unknown })?.code;
  return typeof code === 'string' ? code : undefined;
};

const rejectReason = (err: unknown): string => {
  const code = errorCode(err);

  // jose network failures and a malformed JWKS response are deployment
  // faults, not bad tokens
  if (code === 'ERR_JWKS_TIMEOUT' || code === 'ERR_JWKS_INVALID') {
    return 'jwks_unreachable';
  }
  // fetch transport errors (undici sets ECONNREFUSED / ENOTFOUND / UND_ERR_*)
  if (
    err instanceof TypeError ||
    (code && !code.startsWith('ERR_J')) ||
    err instanceof URIError
  ) {
    return 'jwks_unreachable';
  }
  if (code === 'ERR_JWKS_NO_MATCHING_KEY') {
    return 'no_matching_key';
  }
  if (code === 'ERR_JWT_EXPIRED') {
    return 'expired';
  }
  if (code) {
    return 'invalid_token';
  }
  // plain Error — the missing-claims guard
  return 'invalid_token';
};
