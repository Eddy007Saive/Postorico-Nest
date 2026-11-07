import { Module } from '@nestjs/common';
import { PrismaModule } from '../../config/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { ClaudeModule } from '../claude/claude.module';
import { MarqueModule } from '../marque/marque.module';
import { QuotaModule } from '../quota/quota.module';
import { SocialModule } from '../social/social.module';
import { ZernioModule } from '../zernio/zernio.module';
import { CampagnesEmailController } from './campagnes-email.controller';
import { CampagnesEmailService } from './campagnes-email.service';
import { SuiviEmailController } from './suivi-email.controller';

/** Boîte mail du client (Gmail / Outlook via Zernio) et petites campagnes email personnalisées. */
@Module({
  imports: [
    PrismaModule,
    AuthModule,
    ZernioModule,
    SocialModule,
    QuotaModule,
    ClaudeModule,
    MarqueModule,
  ],
  controllers: [CampagnesEmailController, SuiviEmailController],
  providers: [CampagnesEmailService],
})
export class CampagnesEmailModule {}
