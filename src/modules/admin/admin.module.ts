import { Module } from '@nestjs/common';
import { SiteModule } from '../site/site.module';
import { PrismaModule } from '../../config/prisma.module';
import { AnalyticsModule } from '../analytics/analytics.module';
import { AuthModule } from '../auth/auth.module';
import { BillingModule } from '../billing/billing.module';
import { CarrouselModule } from '../carrousel/carrousel.module';
import { MarqueModule } from '../marque/marque.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PromoModule } from '../promo/promo.module';
import { QuotaModule } from '../quota/quota.module';
import { SocialModule } from '../social/social.module';
import { UsersModule } from '../users/users.module';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';

@Module({
  imports: [
    SiteModule,
    PrismaModule,
    AuthModule,
    BillingModule,
    SocialModule,
    QuotaModule,
    MarqueModule,
    UsersModule,
    CarrouselModule,
    NotificationsModule,
    AnalyticsModule,
    PromoModule,
  ],
  controllers: [AdminController],
  providers: [AdminService],
})
export class AdminModule {}
