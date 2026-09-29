import { Module } from '@nestjs/common';
import { PrismaModule } from '../../config/prisma.module';
import { RateLimitModule } from '../../common/utils/rate-limit.module';
import { AuthModule } from '../auth/auth.module';
import { BanqueModule } from '../banque/banque.module';
import { DemarrageModule } from '../demarrage/demarrage.module';
import { MusicLibraryModule } from '../music/music-library.module';
import { QuotaModule } from '../quota/quota.module';
import { RenderQueueModule } from '../render-queue/render-queue.module';
import { VideoModule } from '../video/video.module';
import { VoixModule } from '../voix/voix.module';
import { EditeurController } from './editeur.controller';
import { EditeurService } from './editeur.service';

@Module({
  imports: [
    RateLimitModule,
    PrismaModule,
    AuthModule,
    BanqueModule,
    MusicLibraryModule,
    QuotaModule,
    RenderQueueModule,
    VideoModule,
    VoixModule,
    DemarrageModule,
  ],
  controllers: [EditeurController],
  providers: [EditeurService],
  exports: [EditeurService],
})
export class EditeurModule {}
