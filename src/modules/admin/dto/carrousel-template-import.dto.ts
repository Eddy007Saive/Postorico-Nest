import { IsString } from 'class-validator';

export class CarrouselTemplateImportDto {
  @IsString()
  id!: string;

  @IsString()
  label!: string;

  @IsString()
  html!: string;
}
