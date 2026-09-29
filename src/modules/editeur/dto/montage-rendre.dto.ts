import { IsOptional, IsString } from 'class-validator';

export class MontageRendreDto {
  @IsOptional()
  @IsString()
  reseau?: string;

  @IsOptional()
  @IsString()
  titre?: string;
}
