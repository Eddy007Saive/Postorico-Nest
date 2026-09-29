import { IsArray, IsOptional, IsString } from 'class-validator';

export class CreateTemplateDto {
  @IsString()
  nom!: string;

  @IsOptional()
  @IsArray()
  images?: string[];

  @IsOptional()
  @IsString()
  note?: string;
}
