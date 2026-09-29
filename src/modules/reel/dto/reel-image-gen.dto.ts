import { IsOptional, IsString } from 'class-validator';

export class ReelImageGenDto {
  @IsOptional()
  @IsString()
  prompt?: string | null;

  @IsOptional()
  @IsString()
  idee?: string | null;

  @IsOptional()
  @IsString()
  texte?: string | null;

  @IsOptional()
  @IsString()
  modele?: string;
}
