import { IsInt, IsOptional, IsString } from 'class-validator';

export class PauseDto {
  @IsOptional()
  @IsInt()
  mois?: number;

  @IsOptional()
  @IsString()
  raison?: string;

  @IsOptional()
  @IsString()
  commentaire?: string;

  @IsOptional()
  @IsString()
  parcours?: string;
}
