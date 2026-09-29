import { IsArray, IsOptional, IsString } from 'class-validator';

export class RecyclerDto {
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  reseaux?: string[];
}
