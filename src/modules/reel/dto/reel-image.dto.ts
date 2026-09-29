import { IsNumber, IsOptional, IsString } from 'class-validator';

export class ReelImageDto {
  @IsString()
  url!: string;

  @IsOptional()
  @IsString()
  desc?: string | null;

  @IsOptional()
  @IsNumber()
  debut?: number | null;

  @IsOptional()
  @IsNumber()
  fin?: number | null;
}
