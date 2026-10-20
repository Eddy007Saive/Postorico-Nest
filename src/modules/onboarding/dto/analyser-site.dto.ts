import { IsOptional, IsString, MaxLength } from 'class-validator';

export class AnalyserSiteDto {
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  url?: string;

  @IsOptional()
  @IsString()
  cf_turnstile_token?: string;

  @IsOptional()
  @IsString()
  turnstile_token?: string;
}
