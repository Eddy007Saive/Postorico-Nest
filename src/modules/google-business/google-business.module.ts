import { Module } from '@nestjs/common';
import { PrismaModule } from '../../config/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { ClaudeModule } from '../claude/claude.module';
import { MarqueModule } from '../marque/marque.module';
import { ZernioModule } from '../zernio/zernio.module';
import { GoogleBusinessController } from './google-business.controller';
import { GoogleBusinessService } from './google-business.service';

/** Fiche Google gérée depuis Postorico : avis, photos, infos et horaires, liens, établissements. */
@Module({
  imports: [PrismaModule, AuthModule, ZernioModule, ClaudeModule, MarqueModule],
  controllers: [GoogleBusinessController],
  providers: [GoogleBusinessService],
})
export class GoogleBusinessModule {}
