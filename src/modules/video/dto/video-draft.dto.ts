import { IsOptional, IsString } from 'class-validator';

export class VideoDraftDto {
  @IsOptional()
  @IsString()
  script?: string | null;

  @IsOptional()
  @IsString()
  titre?: string | null;

  @IsOptional()
  @IsString()
  reseau?: string | null;
}
