import { Module } from '@nestjs/common';
import { KonversifySsoController } from './konversify.sso.controller';
import { KonversifySsoService } from './konversify.sso.service';
import { KonversifySsoRepository } from './konversify.sso.repository';

@Module({
  controllers: [KonversifySsoController],
  providers: [KonversifySsoService, KonversifySsoRepository],
})
export class KonversifySsoModule {}
