import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsOptional, IsString, MaxLength, ValidateNested } from 'class-validator';

export class IdeeMatriceDto {
  @IsString()
  @MaxLength(200)
  sujet!: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  pilier?: string;

  @IsOptional()
  @IsString()
  format?: string;

  @IsOptional()
  @IsString()
  objectif?: string;

  @IsOptional()
  @IsString()
  angle?: string;
}

/** Idées de la matrice gardées par le client : enregistrées comme sujets (déjà payées). */
export class AjouterSujetsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(40)
  @ValidateNested({ each: true })
  @Type(() => IdeeMatriceDto)
  sujets!: IdeeMatriceDto[];
}
