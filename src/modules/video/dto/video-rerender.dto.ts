import { IsArray, IsObject, IsOptional } from 'class-validator';

export class VideoRerenderDto {
  @IsOptional()
  @IsArray()
  words?: Array<{ text?: string; start: number; end: number }>;

  @IsOptional()
  @IsArray()
  removed?: Array<[number, number]>;

  @IsOptional()
  @IsObject()
  options?: Record<string, unknown>;
}
