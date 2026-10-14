import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { OBJECTIFS } from './publicite.util';

export class VilleDto {
  @IsString()
  @MaxLength(30)
  id!: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  nom?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(80)
  rayon_km?: number | null;
}

export class BoostDto {
  @IsString()
  contenu_id!: string;

  @IsString()
  @MaxLength(40)
  compte_pub!: string;

  @IsIn(OBJECTIFS)
  objectif!: (typeof OBJECTIFS)[number];

  @IsNumber()
  @Min(1)
  budget!: number;

  @IsIn(['daily', 'lifetime'])
  type_budget!: 'daily' | 'lifetime';

  @IsOptional()
  @IsString()
  debut?: string | null;

  @IsOptional()
  @IsString()
  fin?: string | null;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(25)
  @ValidateNested({ each: true })
  @Type(() => VilleDto)
  villes?: VilleDto[] | null;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  pays?: string[] | null;

  @IsOptional()
  @IsInt()
  age_min?: number | null;

  @IsOptional()
  @IsInt()
  age_max?: number | null;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  lien?: string | null;

  @IsOptional()
  @IsString()
  bouton?: string | null;
}

export class StatutPubDto {
  @IsBoolean()
  allumer!: boolean;
}

export class ConseilDto {
  @IsString()
  contenu_id!: string;
}
