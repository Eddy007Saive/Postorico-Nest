import { IsIn, IsOptional, IsString } from 'class-validator';

export class MontageSilencesDto {
  @IsString()
  element_id!: string;

  @IsOptional()
  @IsIn(['naturel', 'rythme', 'serre'])
  intensite?: string;
}
