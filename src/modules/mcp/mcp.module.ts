import { Module } from '@nestjs/common';
import { PrismaModule } from '../../config/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { ClesApiController } from './cles-api.controller';
import { ClesApiService } from './cles-api.service';
import { McpController } from './mcp.controller';

@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [ClesApiController, McpController],
  providers: [ClesApiService],
})
export class McpModule {}
