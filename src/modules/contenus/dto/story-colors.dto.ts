import { IsOptional, IsString } from 'class-validator';

export class StoryColorsDto {
  @IsOptional()
  @IsString()
  p?: string;

  @IsOptional()
  @IsString()
  s?: string;

  @IsOptional()
  @IsString()
  a?: string;
}
