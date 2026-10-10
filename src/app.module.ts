import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import appConfig from './config/app.config';
import { AccountsModule } from './modules/accounts/accounts.module';
import { AdminModule } from './modules/admin/admin.module';
import { AffiliationModule } from './modules/affiliation/affiliation.module';
import { AnalyticsModule } from './modules/analytics/analytics.module';
import { WorkflowsModule } from './modules/workflows/workflows.module';
import { AuthModule } from './modules/auth/auth.module';
import { BillingModule } from './modules/billing/billing.module';
import { BrouillonsModule } from './modules/brouillons/brouillons.module';
import { CarrouselModule } from './modules/carrousel/carrousel.module';
import { ClaudeModule } from './modules/claude/claude.module';
import { CommentsModule } from './modules/comments/comments.module';
import { ContenusModule } from './modules/contenus/contenus.module';
import { DemarrageModule } from './modules/demarrage/demarrage.module';
import { EditeurModule } from './modules/editeur/editeur.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { DimensionsModule } from './modules/dimensions/dimensions.module';
import { GabaritModule } from './modules/gabarit/gabarit.module';
import { HeygenModule } from './modules/heygen/heygen.module';
import { ImageModule } from './modules/image/image.module';
import { LateModule } from './modules/late/late.module';
import { MailModule } from './modules/mail/mail.module';
import { MarqueModule } from './modules/marque/marque.module';
import { MemoireModule } from './modules/memoire/memoire.module';
import { NewsletterModule } from './modules/newsletter/newsletter.module';
import { OffersModule } from './modules/offers/offers.module';
import { OnboardingModule } from './modules/onboarding/onboarding.module';
import { PostsModule } from './modules/posts/posts.module';
import { QuotaModule } from './modules/quota/quota.module';
import { ReelModule } from './modules/reel/reel.module';
import { ScriptModule } from './modules/script/script.module';
import { SiteModule } from './modules/site/site.module';
import { VideoModule } from './modules/video/video.module';
import { SocialModule } from './modules/social/social.module';
import { SujetsModule } from './modules/sujets/sujets.module';
import { TurnstileModule } from './modules/turnstile/turnstile.module';
import { UsageModule } from './modules/usage/usage.module';
import { UsersModule } from './modules/users/users.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [appConfig],
      envFilePath: '.env',
    }),
    ScheduleModule.forRoot(),
    MailModule,
    AuthModule,
    ClaudeModule,
    MarqueModule,
    QuotaModule,
    UsageModule,
    OffersModule,
    SocialModule,
    DimensionsModule,
    DemarrageModule,
    MemoireModule,
    SujetsModule,
    PostsModule,
    CarrouselModule,
    ScriptModule,
    ImageModule,
    GabaritModule,
    LateModule,
    BillingModule,
    UsersModule,
    ContenusModule,
    AdminModule,
    AccountsModule,
    BrouillonsModule,
    ReelModule,
    VideoModule,
    EditeurModule,
    NotificationsModule,
    CommentsModule,
    HeygenModule,
    AnalyticsModule,
    AffiliationModule,
    TurnstileModule,
    NewsletterModule,
    OnboardingModule,
    SiteModule,
    WorkflowsModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
