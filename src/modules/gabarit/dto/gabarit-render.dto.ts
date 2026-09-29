import { IsNotEmpty, IsObject, IsOptional, IsString } from 'class-validator';

export class GabaritRenderDto {
  @IsString()
  @IsNotEmpty()
  gabarit!: string;

  @IsOptional()
  @IsObject()
  slots?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  contenu_id?: string;
}
