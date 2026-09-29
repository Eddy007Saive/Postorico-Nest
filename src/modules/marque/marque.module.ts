import { Module } from '@nestjs/common';
import { PrismaModule } from '../../config/prisma.module';
import { MarqueService } from './marque.service';

@Module({
  imports: [PrismaModule],
  providers: [MarqueService],
  exports: [MarqueService],
})
export class MarqueModule {}
