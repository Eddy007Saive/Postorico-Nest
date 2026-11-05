import { IsObject, IsOptional, IsString, MaxLength } from 'class-validator';

export class MajSujetDto {
  @IsOptional()
  @IsObject()
  dimensions?: Record<string, unknown>;

  /** Nouveau texte du sujet (connecteur IA). */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  titre?: string;
}
