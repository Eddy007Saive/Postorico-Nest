import { IsOptional, IsString } from 'class-validator';

export class ParcoursRetenuDto {
  @IsOptional()
  @IsString()
  parcours?: string;

  @IsOptional()
  @IsString()
  detail?: string;
}
