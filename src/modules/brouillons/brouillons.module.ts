import { Module } from '@nestjs/common';
import { PrismaModule } from '../../config/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { BrouillonsController } from './brouillons.controller';

@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [BrouillonsController],
  providers: [],
})
export class BrouillonsModule {}
