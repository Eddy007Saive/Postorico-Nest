import { IsNumber, IsOptional } from 'class-validator';

export class DecoupageMusiqueDto {
  @IsOptional()
  @IsNumber()
  debut_s?: number | null;

  @IsOptional()
  @IsNumber()
  duree_s?: number | null;
}
