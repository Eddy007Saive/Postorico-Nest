import { IsBoolean, IsOptional, IsString } from 'class-validator';

export class InspirationIntegrateDto {
  @IsString()
  url!: string;

  @IsOptional()
  @IsBoolean()
  integrate?: boolean;
}
