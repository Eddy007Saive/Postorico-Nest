import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { SiteController } from './site.controller';
import { SiteService } from './site.service';

@Module({
  imports: [AuthModule],
  controllers: [SiteController],
  providers: [SiteService],
  exports: [SiteService],
})
export class SiteModule {}