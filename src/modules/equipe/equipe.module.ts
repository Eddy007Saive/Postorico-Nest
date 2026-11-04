import { Module } from '@nestjs/common';
import { PrismaModule } from '../../config/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { MailModule } from '../mail/mail.module';
import { EquipeController } from './equipe.controller';
import { EquipeService } from './equipe.service';

@Module({
  imports: [PrismaModule, AuthModule, MailModule],
  controllers: [EquipeController],
  providers: [EquipeService],
})
export class EquipeModule {}
