import { Module } from '@nestjs/common';
import { PrismaModule } from '../../config/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { LateModule } from '../late/late.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { ZernioModule } from '../zernio/zernio.module';
import { CommentaireController } from './commentaire.controller';
import { CommentaireService } from './commentaire.service';
import { InboxController } from './inbox.controller';
import { InboxService } from './inbox.service';

@Module({
  imports: [
    PrismaModule,
    AuthModule,
    LateModule,
    NotificationsModule,
    ZernioModule,
  ],
  controllers: [CommentaireController, InboxController],
  providers: [CommentaireService, InboxService],
})
export class CommentsModule {}
