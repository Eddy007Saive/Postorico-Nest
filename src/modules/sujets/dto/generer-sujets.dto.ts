import { IsInt, IsObject, IsOptional, Max, Min } from 'class-validator';

export class GenererSujetsDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20)
  nombre?: number;

  @IsOptional()
  @IsObject()
  filtres?: Record<string, unknown>;
}
