import { IsIn, IsNumber, IsOptional, IsString } from 'class-validator';

export class AdminDeciderDto {
  @IsOptional()
  @IsIn(['actif', 'refuse', 'suspendu'])
  statut?: string;

  @IsOptional()
  @IsString()
  motif?: string;

  @IsOptional()
  @IsNumber()
  taux_setup?: number;

  @IsOptional()
  @IsNumber()
  taux_recurrent?: number;
}
