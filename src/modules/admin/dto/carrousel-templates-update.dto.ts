import { IsArray, IsOptional, IsString } from 'class-validator';

export class CarrouselTemplatesUpdateDto {
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  templates?: string[];
}
