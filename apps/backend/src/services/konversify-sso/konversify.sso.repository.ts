import { Injectable } from '@nestjs/common';
import { PrismaRepository } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { AuthService } from '@gitroom/helpers/auth/auth.service';
import { makeId } from '@gitroom/nestjs-libraries/services/make.is';
import { Role, User } from '@prisma/client';
import type { KonversifySsoClaims } from './konversify.sso.service';

// ChatbotX workspaces map 1:1 to Postiz organizations. The organization model
// has no external-key column, so the deterministic key is the organization
// name: "konversify-ws-<workspaceId>". Only this module creates organizations
// with that name pattern.
export const konversifyOrgName = (workspaceId: string) =>
  `konversify-ws-${workspaceId}`;

@Injectable()
export class KonversifySsoRepository {
  constructor(
    private _organization: PrismaRepository<'organization'>,
    private _userOrg: PrismaRepository<'userOrganization'>,
    private _user: PrismaRepository<'user'>
  ) {}

  async ensureOrganization(workspaceId: string) {
    const name = konversifyOrgName(workspaceId);
    const existing = await this._organization.model.organization.findFirst({
      where: { name, deletedAt: null },
      orderBy: { createdAt: 'asc' },
    });
    if (existing) {
      return existing;
    }

    return this._organization.model.organization.create({
      data: {
        name,
        apiKey: AuthService.fixedEncryption(makeId(20)),
        allowTrial: true,
        isTrailing: true,
      },
    });
  }

  async ensureUser(claims: KonversifySsoClaims, ip: string, userAgent: string) {
    const existing = await this.findUserByEmail(claims.email);
    if (existing) {
      return existing;
    }

    return this._user.model.user.create({
      data: {
        email: claims.email,
        name: claims.email.split('@')[0],
        // random password: SSO users sign in through Konversify only
        password: AuthService.hashPassword(makeId(64)),
        providerName: 'LOCAL',
        providerId: '',
        timezone: 0,
        activated: true,
        ip,
        agent: userAgent,
      },
    });
  }

  findUserByEmail(email: string): Promise<User | null> {
    return this._user.model.user.findFirst({
      where: {
        email: {
          equals: email,
          mode: 'insensitive',
        },
        providerName: 'LOCAL',
        deletedAt: null,
      },
    });
  }

  // SUPERADMIN is Postiz's owner-grade role (the role createOrgAndUser gives
  // the founding user); every Konversify workspace member arrives as its owner.
  async ensureMembership(userId: string, organizationId: string) {
    return this._userOrg.model.userOrganization.upsert({
      where: {
        userId_organizationId: {
          userId,
          organizationId,
        },
      },
      update: {
        role: Role.SUPERADMIN,
        disabled: false,
      },
      create: {
        userId,
        organizationId,
        role: Role.SUPERADMIN,
      },
    });
  }
}
