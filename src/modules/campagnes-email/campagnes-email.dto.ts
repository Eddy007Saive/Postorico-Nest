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

export class ConnecterBoiteDto {
  @IsIn(['google', 'microsoft'])
  fournisseur!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  adresse?: string;
}

export class ContactDto {
  @IsString()
  @MaxLength(200)
  email!: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  prenom?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  entreprise?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string | null;
}

export class CreerCampagneDto {
  @IsString()
  @MaxLength(120)
  nom!: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  consigne?: string;

  @IsOptional()
  @IsInt()
  @Min(5)
  @Max(40)
  par_heure?: number;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(1000)
  @ValidateNested({ each: true })
  @Type(() => ContactDto)
  contacts?: ContactDto[];
}

export class ModifierCampagneDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  nom?: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  consigne?: string;

  @IsOptional()
  @IsInt()
  @Min(5)
  @Max(40)
  par_heure?: number;
}

export class ContactsDto {
  @IsArray()
  @ArrayMaxSize(1000)
  @ValidateNested({ each: true })
  @Type(() => ContactDto)
  contacts!: ContactDto[];
}

export class MailDestinataireDto {
  @IsString()
  @MaxLength(200)
  objet!: string;

  @IsString()
  @MaxLength(5000)
  corps!: string;
}

export class RedigerDto {
  @IsOptional()
  @IsBoolean()
  tout?: boolean;
}

export class RepondreDto {
  @IsString()
  @MaxLength(10000)
  texte!: string;
}

export class EcrireDto {
  @IsString()
  @MaxLength(200)
  a!: string;

  @IsString()
  @MaxLength(200)
  objet!: string;

  @IsString()
  @MaxLength(10000)
  texte!: string;
}
