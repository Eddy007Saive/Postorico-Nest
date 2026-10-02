import { Module } from '@nestjs/common';
import { ContenuEvenementModule } from '../contenus/contenu-evenement.module';
import { PrismaModule } from '../../config/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { MusicLibraryModule } from '../music/music-library.module';
import { QuotaModule } from '../quota/quota.module';
import { MontagePocService } from './montage-poc.service';
import { VideoController } from './video.controller';
import { VideoService } from './video.service';

@Module({
  imports: [PrismaModule, AuthModule, QuotaModule, MusicLibraryModule, ContenuEvenementModule],
  controllers: [VideoController],
  providers: [VideoService, MontagePocService],
  exports: [VideoService, MontagePocService],
})
export class VideoModule {}
