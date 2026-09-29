import { Module } from '@nestjs/common';
import { ZernioClientService } from './zernio-client.service';

@Module({
  providers: [ZernioClientService],
  exports: [ZernioClientService],
})
export class ZernioModule {}
