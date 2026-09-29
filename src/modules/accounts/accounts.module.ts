import { Module } from '@nestjs/common';
import { PrismaModule } from '../../config/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { UsersModule } from '../users/users.module';
import { AccountsController } from './accounts.controller';
import { AccountsService } from './accounts.service';

@Module({
  imports: [PrismaModule, AuthModule, UsersModule],
  controllers: [AccountsController],
  providers: [AccountsService],
})
export class AccountsModule {}
