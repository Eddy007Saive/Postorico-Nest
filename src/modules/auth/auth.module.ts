import { forwardRef, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { RateLimitModule } from '../../common/utils/rate-limit.module';
import { PrismaModule } from '../../config/prisma.module';
import { AffiliationModule } from '../affiliation/affiliation.module';
import { MailModule } from '../mail/mail.module';
import { SocialModule } from '../social/social.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AdminGuard } from './guards/admin.guard';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { MfaService } from './mfa.service';

const jwtModule = JwtModule.registerAsync({
  imports: [ConfigModule],
  inject: [ConfigService],
  useFactory: (config: ConfigService) => ({
    secret: config.get<string>('app.jwtSecret'),
    signOptions: { expiresIn: '7d' }, // valeur par défaut ; surchargée par issueToken() au cas par cas
  }),
});

@Module({
  imports: [
    MailModule,
    forwardRef(() => SocialModule),
    forwardRef(() => AffiliationModule),
    jwtModule,
    PrismaModule,
    RateLimitModule,
  ],
  controllers: [AuthController],
  providers: [AuthService, MfaService, JwtAuthGuard, AdminGuard],
  // JwtModule est ré-exporté : JwtAuthGuard dépend de JwtService, et tout module qui réutilise
  // le guard (ex. AgentModule) via `@UseGuards(JwtAuthGuard)` a besoin que JwtService soit
  // résoluble dans son propre graphe d'injection, pas seulement dans celui d'AuthModule.
  exports: [AuthService, MfaService, JwtAuthGuard, AdminGuard, jwtModule],
})
export class AuthModule {}
