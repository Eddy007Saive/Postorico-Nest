import { Module } from '@nestjs/common';
import { PrismaModule } from '../../config/prisma.module';
import { MusicLibraryService } from './music-library.service';

@Module({
  imports: [PrismaModule],
  providers: [MusicLibraryService],
  exports: [MusicLibraryService],
})
export class MusicLibraryModule {}
