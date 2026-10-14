import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export class RushDto {
  @IsString()
  url!: string;
}

/** Photo de la banque du client, à placer par l'agent. */
export class ImageDto {
  @IsString()
  url!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  description?: string | null;
}

/** Demande d'un client : sa ou ses vidéos + ce qu'il attend du montage. */
export class AgentVideoCreerDto {
  @IsOptional()
  @IsIn(['video', 'motion'])
  mode?: 'video' | 'motion' | null;

  // Obligatoire en mode « video » (contrôlé par le service), absent en mode « motion »
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => RushDto)
  clips?: RushDto[] | null;

  @IsOptional()
  @IsString()
  @MaxLength(3000)
  script?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  voix?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(1500)
  consignes?: string | null;

  @IsOptional()
  @IsString()
  reseau?: string | null;

  @IsOptional()
  @IsIn(['9:16', '16:9', '1:1'])
  format?: string | null;

  @IsOptional()
  @IsInt()
  @Min(5)
  @Max(600)
  duree_max_s?: number | null;

  @IsOptional()
  @IsBoolean()
  illustrations?: boolean | null;

  @IsOptional()
  @IsBoolean()
  logo?: boolean | null;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => ImageDto)
  images?: ImageDto[] | null;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  musique?: string | null;

  @IsOptional()
  @IsInt()
  @Min(5)
  @Max(100)
  musique_volume?: number | null;
}

/** Correction demandée par le client sur un montage terminé. */
export class AgentVideoCorrectionDto {
  @IsOptional()
  @IsString()
  @MaxLength(1500)
  consignes?: string | null;

  /** Nouvelle musique de fond (id de la bibliothèque, ou « none » pour la retirer). */
  @IsOptional()
  @IsString()
  @MaxLength(80)
  musique?: string | null;

  @IsOptional()
  @IsInt()
  @Min(5)
  @Max(100)
  musique_volume?: number | null;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => ImageDto)
  images?: ImageDto[] | null;
}
