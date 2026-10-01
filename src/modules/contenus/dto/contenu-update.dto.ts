import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

/** Port direct de backend/models/contenu.py::ContenuUpdate. */
export class ContenuUpdateDto {
  @IsOptional()
  @IsString()
  statut?: string;

  /** Note de ressemblance perçue (1-5), saisie par le dirigeant à la validation — mesure H2.
   * Doit être déclarée ici : la ValidationPipe globale (`whitelist: true`) supprime
   * silencieusement tout champ absent du DTO, et le tableau Verdict H2 resterait vide. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5)
  note_ressemblance?: number;

  /** Motif saisi lors d'un refus (statut Refuse) — journalisé dans contenu_evenement. */
  @IsOptional()
  @IsString()
  motif_refus?: string;

  @IsOptional()
  @IsString()
  titre?: string;

  @IsOptional()
  @IsString()
  contenu?: string;

  @IsOptional()
  @IsString()
  date_publication?: string;
}
