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

    const created = await this._organization.model.organization.create({
      data: {
        name,
        apiKey: AuthService.fixedEncryption(makeId(20)),
        allowTrial: true,
        isTrailing: true,
      },
    });

    // two concurrent first logins for the same workspace can both pass the
    // findFirst above (name is not a unique column): the oldest org is the
    // canonical one, so drop the loser. Nothing can reference it yet —
    // memberships are created after this resolves.
    const canonical = await this._organization.model.organization.findFirst({
      where: { name, deletedAt: null },
      orderBy: { createdAt: 'asc' },
    });
    if (canonical.id !== created.id) {
      await this._organization.model.organization.delete({
        where: { id: created.id },
      });
      return canonical;
    }

    return created;
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
      // email is not a unique column either: oldest row wins deterministically
      orderBy: { createdAt: 'asc' },
    });
  }

  // SUPERADMIN is Postiz's owner-grade role; ADMIN is the workspace-member
  // grade. The shell mints the token with the member's role in the target
  // workspace ("owner" | "agent"), so only actual workspace owners get
  // org-destructive powers in Postiz.
  async ensureMembership(
    userId: string,
    organizationId: string,
    shellRole: string,
  ) {
    const role =
      shellRole.toLowerCase() === 'owner' ? Role.SUPERADMIN : Role.ADMIN
    return this._userOrg.model.userOrganization.upsert({
      where: {
        userId_organizationId: {
          userId,
          organizationId,
        },
      },
      update: {
        role,
        disabled: false,
      },
      create: {
        userId,
        organizationId,
        role,
      },
    });
  }
}
