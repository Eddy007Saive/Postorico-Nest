import { Module } from '@nestjs/common';
import { PrismaModule } from '../../config/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { ClaudeModule } from '../claude/claude.module';
import { MarqueModule } from '../marque/marque.module';
import { QuotaModule } from '../quota/quota.module';
import { ZernioModule } from '../zernio/zernio.module';
import { PubliciteController } from './publicite.controller';
import { PubliciteService } from './publicite.service';

/** Publicités Meta (Facebook / Instagram) gérées depuis Postorico via Zernio. */
@Module({
  imports: [
    PrismaModule,
    AuthModule,
    ZernioModule,
    ClaudeModule,
    MarqueModule,
    QuotaModule,
  ],
  controllers: [PubliciteController],
  providers: [PubliciteService],
})
export class PubliciteModule {}
