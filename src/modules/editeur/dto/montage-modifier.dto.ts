import { IsObject, IsOptional, IsString } from 'class-validator';

export class MontageModifierDto {
  @IsOptional()
  @IsObject()
  projet?: Record<string, unknown> | null;

  @IsOptional()
  @IsString()
  titre?: string | null;
}
