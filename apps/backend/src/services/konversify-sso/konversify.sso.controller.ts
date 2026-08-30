import { Body, Controller, NotFoundException, Post, Res } from '@nestjs/common';
import { Response } from 'express';
import { ApiTags } from '@nestjs/swagger';
import { RealIP } from 'nestjs-real-ip';
import { UserAgent } from '@gitroom/nestjs-libraries/user/user.agent';
import { getCookieUrlFromDomain } from '@gitroom/helpers/subdomain/subdomain.management';
import { KonversifySsoDto } from '@gitroom/nestjs-libraries/dtos/auth/konversify.sso.dto';
import { KonversifySsoService } from './konversify.sso.service';

@ApiTags('Integrations')
@Controller('/integrations')
export class KonversifySsoController {
  constructor(private _konversifySsoService: KonversifySsoService) {}

  @Post('/konversify-sso')
  async konversifySso(
    @Body() body: KonversifySsoDto,
    @Res({ passthrough: false }) response: Response,
    @RealIP() ip: string,
    @UserAgent() userAgent: string
  ) {
    if (!this._konversifySsoService.isEnabled()) {
      throw new NotFoundException();
    }

    const { jwt, organizationId } = await this._konversifySsoService.loginWithToken(
      body.token,
      ip,
      userAgent
    );

    // cookie setup mirrors POST /auth/login; the /sso page performs the
    // redirect itself, so no `reload` header is sent here
    response.cookie('auth', jwt, {
      domain: getCookieUrlFromDomain(process.env.FRONTEND_URL!),
      ...(!process.env.NOT_SECURED
        ? {
            secure: true,
            httpOnly: true,
            sameSite: 'none',
          }
        : {}),
      expires: new Date(Date.now() + 1000 * 60 * 60 * 24 * 365),
    });

    response.cookie('showorg', organizationId, {
      domain: getCookieUrlFromDomain(process.env.FRONTEND_URL!),
      ...(!process.env.NOT_SECURED
        ? {
            secure: true,
            httpOnly: true,
            sameSite: 'none',
          }
        : {}),
      expires: new Date(Date.now() + 1000 * 60 * 60 * 24 * 365),
    });

    if (process.env.NOT_SECURED) {
      response.header('auth', jwt);
      response.header('showorg', organizationId);
    }

    response.status(200).json({
      login: true,
    });
  }
}
