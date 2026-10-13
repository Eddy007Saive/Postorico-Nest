import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export class ReponseAvisDto {
  @IsString()
  @MaxLength(4000)
  message!: string;
}

export class SuggestionAvisDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  auteur?: string | null;

  @IsInt()
  @Min(1)
  @Max(5)
  note!: number;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  texte?: string | null;
}

export class PhotoFicheDto {
  @IsString()
  url!: string;

  @IsOptional()
  @IsString()
  categorie?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  description?: string | null;
}

export class HoraireSpecialDto {
  @IsString()
  date!: string;

  @IsBoolean()
  ferme!: boolean;

  @IsOptional()
  @IsString()
  debut?: string;

  @IsOptional()
  @IsString()
  fin?: string;
}

export class InfosFicheDto {
  @IsOptional()
  @IsString()
  @MaxLength(750)
  description?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  telephone?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  site?: string | null;

  /** { MONDAY: [{ debut: '09:00', fin: '18:00' }], … } */
  @IsOptional()
  @IsObject()
  horaires?: Record<string, Array<{ debut: string; fin: string }>> | null;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => HoraireSpecialDto)
  horaires_speciaux?: HoraireSpecialDto[] | null;
}

export class LienFicheDto {
  @IsString()
  url!: string;

  @IsString()
  type!: string;
}

export class EtablissementDto {
  @IsString()
  id!: string;
}
