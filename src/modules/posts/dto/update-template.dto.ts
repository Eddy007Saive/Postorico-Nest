import { IsOptional, IsString, MaxLength } from 'class-validator';

/** Modification d'un template de marque : nom et/ou note d'utilisation (la directive de style
 * envoyée à l'IA quand le template est choisi). Une note vide l'efface. */
export class UpdateTemplateDto {
  @IsOptional()
  @IsString()
  @MaxLength(80)
  nom?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}
