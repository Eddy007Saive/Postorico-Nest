import { Module } from '@nestjs/common';
import { TranscodageService } from './transcodage.service';

/** Conversion ffmpeg des vidéos importées, avant Cloudinary (banque, Studio vidéo). */
@Module({
  providers: [TranscodageService],
  exports: [TranscodageService],
})
export class TranscodageModule {}
