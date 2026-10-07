import { Module } from '@nestjs/common';
import { PrismaModule } from '../../config/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { CarrouselModule } from '../carrousel/carrousel.module';
import { DemarrageModule } from '../demarrage/demarrage.module';
import { ImpayeModule } from '../impaye/impaye.module';
import { MarqueModule } from '../marque/marque.module';
import { QuotaModule } from '../quota/quota.module';
import { SocialModule } from '../social/social.module';
import { ScheduleService } from './schedule.service';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  imports: [
    PrismaModule,
    AuthModule,
    MarqueModule,
    SocialModule,
    DemarrageModule,
    QuotaModule,
    CarrouselModule,
    ImpayeModule,
  ],
  controllers: [UsersController],
  providers: [UsersService, ScheduleService],
  exports: [UsersService],
})
export class UsersModule {}
