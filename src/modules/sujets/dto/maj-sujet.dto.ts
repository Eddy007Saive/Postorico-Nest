import { IsObject, IsOptional } from 'class-validator';

export class MajSujetDto {
  @IsOptional()
  @IsObject()
  dimensions?: Record<string, unknown>;
}
