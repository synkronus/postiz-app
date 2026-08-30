import http from 'http';
import crypto from 'crypto';
import { AddressInfo } from 'net';
import { NotFoundException } from '@nestjs/common';
import { exportJWK, SignJWT } from 'jose';
import { AuthService } from '@gitroom/helpers/auth/auth.service';
import { KonversifySsoService } from './konversify.sso.service';
import { KonversifySsoController } from './konversify.sso.controller';
import {
  KonversifySsoRepository,
  konversifyOrgName,
} from './konversify.sso.repository';

process.env.JWT_SECRET =
  'test-jwt-secret-do-not-use-in-production-0123456789';
process.env.FRONTEND_URL = 'http://localhost:4200';
process.env.KONVERSIFY_SSO_ISSUER = 'https://my.konversify.app';
process.env.KONVERSIFY_SSO_AUDIENCE = 'konversify-tools';

const ISSUER = process.env.KONVERSIFY_SSO_ISSUER!;
const AUDIENCE = process.env.KONVERSIFY_SSO_AUDIENCE!;
const KID = 'test-key-1';

let jwksServer: http.Server;
let signingKey: crypto.KeyObject;
let keyCounter = 0;

// mock JWKS endpoint of the Konversify shell, backed by a locally generated
// ES256 keypair
beforeAll(async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', {
    namedCurve: 'P-256',
  });
  signingKey = privateKey;
  const jwk = {
    ...(await exportJWK(publicKey)),
    kid: KID,
    alg: 'ES256',
    use: 'sig',
  };

  jwksServer = http.createServer((req, res) => {
    if (req.url?.includes('/jwks.json')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ keys: [jwk] }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) =>
    jwksServer.listen(0, '127.0.0.1', resolve)
  );
  process.env.KONVERSIFY_JWKS_URL = `http://127.0.0.1:${
    (jwksServer.address() as AddressInfo).port
  }/jwks.json`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => jwksServer.close(() => resolve()));
});

const mintToken = (
  claims: Record<string, unknown>,
  options: {
    audience?: string;
    issuer?: string;
    expiresIn?: string;
    kid?: string;
  } = {},
  key: crypto.KeyObject = signingKey
) =>
  new SignJWT(claims as never)
    .setProtectedHeader({ alg: 'ES256', kid: options.kid ?? KID, typ: 'JWT' })
    .setIssuedAt()
    .setIssuer(options.issuer ?? ISSUER)
    .setAudience(options.audience ?? AUDIENCE)
    .setExpirationTime(options.expiresIn ?? '2m')
    .sign(key);

const validClaims = () => ({
  sub: 'cx-user-1',
  email: 'owner@konversify.app',
  workspaceId: 'ws_123',
  role: 'OWNER',
});

// ---- in-memory stand-in for the prisma models the repository touches ----
type Org = { id: string; name: string; deletedAt: Date | null };
type User = {
  id: string;
  email: string;
  password: string;
  name: string;
  activated: boolean;
  providerName: string;
};
type Membership = {
  id: string;
  userId: string;
  organizationId: string;
  role: string;
  disabled: boolean;
};

class MemoryDb {
  orgs: Org[] = [];
  users: User[] = [];
  memberships: Membership[] = [];
  // simulates a concurrent first login: the next lookup misses an
  // organization that already exists
  skipNextOrgFind = false;

  repository() {
    const db = this;
    const models = {
      model: {
        organization: {
          findFirst: async ({ where }: any) => {
            if (db.skipNextOrgFind) {
              db.skipNextOrgFind = false;
              return null;
            }
            return (
              db.orgs.find((o) => o.name === where.name && !o.deletedAt) ??
              null
            );
          },
          create: async ({ data }: any) => {
            const org: Org = {
              id: `org-${++keyCounter}`,
              name: data.name,
              deletedAt: null,
            };
            db.orgs.push(org);
            return org;
          },
          delete: async ({ where }: any) => {
            const index = db.orgs.findIndex((o) => o.id === where.id);
            db.orgs.splice(index, 1);
            return db.orgs[index] ?? db.orgs[0] ?? null;
          },
        },
        user: {
          findFirst: async ({ where }: any) =>
            db.users.find(
              (u) =>
                u.email.toLowerCase() === where.email.equals.toLowerCase() &&
                u.providerName === where.providerName
            ) ?? null,
          create: async ({ data }: any) => {
            const user: User = {
              id: `user-${++keyCounter}`,
              email: data.email,
              password: data.password,
              name: data.name,
              activated: data.activated,
              providerName: data.providerName,
            };
            db.users.push(user);
            return user;
          },
        },
        userOrganization: {
          upsert: async ({ where, update, create }: any) => {
            const existing = db.memberships.find(
              (m) =>
                m.userId === where.userId_organizationId.userId &&
                m.organizationId === where.userId_organizationId.organizationId
            );
            if (existing) {
              Object.assign(existing, update);
              return existing;
            }
            const created = { id: `uorg-${++keyCounter}`, disabled: false, ...create };
            db.memberships.push(created);
            return created;
          },
        },
      },
    };
    // the same model surface is handed to all three constructor slots
    return new KonversifySsoRepository(models as never, models as never, models as never);
  }
}

const makeService = (db: MemoryDb) => new KonversifySsoService(db.repository());

describe('KonversifySsoService', () => {
  beforeEach(() => {
    process.env.KONVERSIFY_SSO_ENABLED = 'true';
  });

  it('a valid token yields a Postiz session for the JIT user and workspace org', async () => {
    const db = new MemoryDb();
    const service = makeService(db);
    const token = await mintToken(validClaims());

    const session = await service.loginWithToken(token, '127.0.0.1', 'jest');

    expect(session.organizationId).toBe(db.orgs[0].id);
    expect(db.orgs[0].name).toBe(konversifyOrgName('ws_123'));
    expect(db.orgs).toHaveLength(1);
    expect(db.users).toHaveLength(1);
    expect(db.users[0].email).toBe('owner@konversify.app');
    expect(db.users[0].activated).toBe(true);
    // random strong password: dashboard password login is impossible
    expect(db.users[0].password.length).toBeGreaterThanOrEqual(60);
    expect(db.memberships).toHaveLength(1);
    expect(db.memberships[0].role).toBe('SUPERADMIN');
    expect(db.memberships[0].userId).toBe(db.users[0].id);
    expect(db.memberships[0].organizationId).toBe(db.orgs[0].id);

    // standard Postiz session JWT: signed user payload, password stripped
    const decoded = AuthService.verifyJWT(session.jwt) as Record<string, unknown>;
    expect(decoded.id).toBe(db.users[0].id);
    expect(decoded.password).toBeUndefined();
  });

  it('a second login for the same workspace reuses the org, the user and the membership', async () => {
    const db = new MemoryDb();
    const service = makeService(db);

    await service.loginWithToken(await mintToken(validClaims()), 'ip', 'ua');
    await service.loginWithToken(await mintToken(validClaims()), 'ip', 'ua');

    expect(db.orgs).toHaveLength(1);
    expect(db.users).toHaveLength(1);
    expect(db.memberships).toHaveLength(1);
  });

  it('re-enables a disabled membership of a returning user', async () => {
    const db = new MemoryDb();
    const service = makeService(db);

    await service.loginWithToken(await mintToken(validClaims()), 'ip', 'ua');
    db.memberships[0].disabled = true;

    await service.loginWithToken(await mintToken(validClaims()), 'ip', 'ua');

    expect(db.memberships[0].disabled).toBe(false);
    expect(db.memberships[0].role).toBe('SUPERADMIN');
  });

  it('a concurrent first login keeps the older organization as canonical', async () => {
    const db = new MemoryDb();
    const preExisting: Org = {
      id: 'org-preexisting',
      name: konversifyOrgName('ws_123'),
      deletedAt: null,
    };
    db.orgs.push(preExisting);
    db.skipNextOrgFind = true; // both first logins missed each other's create

    const service = makeService(db);
    const session = await service.loginWithToken(
      await mintToken(validClaims()),
      'ip',
      'ua'
    );

    expect(db.orgs).toHaveLength(1);
    expect(db.orgs[0].id).toBe('org-preexisting');
    expect(session.organizationId).toBe('org-preexisting');
    expect(db.memberships[0].organizationId).toBe('org-preexisting');
  });

  it('a token with the wrong audience is rejected with 401', async () => {
    const service = makeService(new MemoryDb());
    const token = await mintToken(validClaims(), { audience: 'some-other-tool' });

    await expect(service.loginWithToken(token, 'ip', 'ua')).rejects.toMatchObject(
      { status: 401 }
    );
  });

  it('an expired token is rejected with 401', async () => {
    const service = makeService(new MemoryDb());
    const token = await mintToken(validClaims(), { expiresIn: '-1m' });

    await expect(service.loginWithToken(token, 'ip', 'ua')).rejects.toMatchObject(
      { status: 401 }
    );
  });

  it('a token from a different issuer is rejected with 401', async () => {
    const service = makeService(new MemoryDb());
    const token = await mintToken(validClaims(), {
      issuer: 'https://evil.example',
    });

    await expect(service.loginWithToken(token, 'ip', 'ua')).rejects.toMatchObject(
      { status: 401 }
    );
  });

  it('a token signed by a key that is not in the JWKS is rejected with 401', async () => {
    const service = makeService(new MemoryDb());
    const stranger = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const token = await mintToken(validClaims(), { kid: 'unknown-kid' }, stranger.privateKey);

    await expect(service.loginWithToken(token, 'ip', 'ua')).rejects.toMatchObject(
      { status: 401 }
    );
  });

  it('a token without an email claim is rejected with 401', async () => {
    const service = makeService(new MemoryDb());
    const token = await mintToken({ ...validClaims(), email: '' });

    await expect(service.loginWithToken(token, 'ip', 'ua')).rejects.toMatchObject(
      { status: 401 }
    );
  });

  it('a half-configured deployment is unavailable (503), never silently accepting', async () => {
    const service = makeService(new MemoryDb());
    const issuer = process.env.KONVERSIFY_SSO_ISSUER;
    delete process.env.KONVERSIFY_SSO_ISSUER;

    try {
      await expect(
        service.loginWithToken(await mintToken(validClaims()), 'ip', 'ua')
      ).rejects.toMatchObject({ status: 503 });
    } finally {
      process.env.KONVERSIFY_SSO_ISSUER = issuer!;
    }
  });

  it('an unreachable JWKS endpoint is a server fault (503), not an invalid token (401)', async () => {
    const service = makeService(new MemoryDb());
    const jwksUrl = process.env.KONVERSIFY_JWKS_URL;
    // nothing listens on this port
    process.env.KONVERSIFY_JWKS_URL = 'http://127.0.0.1:9/jwks.json';

    try {
      await expect(
        service.loginWithToken(await mintToken(validClaims()), 'ip', 'ua')
      ).rejects.toMatchObject({ status: 503 });
    } finally {
      process.env.KONVERSIFY_JWKS_URL = jwksUrl;
    }
  });
});

describe('KonversifySsoController', () => {
  const makeResponse = (): any => {
    const res = {
      cookies: {} as Record<string, string>,
      headers: {} as Record<string, string>,
      statusCode: 0,
      body: undefined as unknown,
      cookie(name: string, value: string) {
        res.cookies[name] = value;
      },
      header(name: string, value: string) {
        res.headers[name] = value;
      },
      status(code: number) {
        res.statusCode = code;
        return res;
      },
      json(body: unknown) {
        res.body = body;
      },
    };
    return res;
  };

  beforeEach(() => {
    process.env.KONVERSIFY_SSO_ENABLED = 'true';
  });

  it('returns 404 when the feature flag is not "true"', async () => {
    process.env.KONVERSIFY_SSO_ENABLED = 'false';
    const controller = new KonversifySsoController(makeService(new MemoryDb()));

    await expect(
      controller.konversifySso({ token: 'anything' }, makeResponse(), 'ip', 'ua')
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('sets the login cookies on success', async () => {
    const db = new MemoryDb();
    const controller = new KonversifySsoController(makeService(db));
    const res = makeResponse();

    await controller.konversifySso(
      { token: await mintToken(validClaims()) },
      res,
      'ip',
      'ua'
    );

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ login: true });
    expect(AuthService.verifyJWT(res.cookies.auth)).toMatchObject({
      email: 'owner@konversify.app',
    });
    expect(res.cookies.showorg).toBe(db.orgs[0].id);
  });

  it('propagates the 401 from token verification', async () => {
    const controller = new KonversifySsoController(makeService(new MemoryDb()));

    await expect(
      controller.konversifySso(
        { token: await mintToken(validClaims(), { audience: 'wrong' }) },
        makeResponse(),
        'ip',
        'ua'
      )
    ).rejects.toMatchObject({ status: 401 });
  });
});
