import { Module } from '@nestjs/common';
import { PrismaModule } from '../../config/prisma.module';
import { PlanService } from './plan.service';
import { PlanningService } from './planning.service';

@Module({
  imports: [PrismaModule],
  providers: [PlanningService, PlanService],
  exports: [PlanningService, PlanService],
})
export class PlanningModule {}
