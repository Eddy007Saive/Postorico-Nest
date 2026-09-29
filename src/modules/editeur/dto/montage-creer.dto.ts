import { IsObject, IsOptional, IsString } from 'class-validator';

export class MontageCreerDto {
  @IsOptional()
  @IsString()
  titre?: string | null;

  @IsOptional()
  @IsObject()
  projet?: Record<string, unknown> | null;

  @IsOptional()
  @IsString()
  source_contenu_id?: string | null;
}
