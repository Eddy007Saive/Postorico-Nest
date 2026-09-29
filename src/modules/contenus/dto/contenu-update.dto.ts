import { IsOptional, IsString } from 'class-validator';

/** Port direct de backend/models/contenu.py::ContenuUpdate. */
export class ContenuUpdateDto {
  @IsOptional()
  @IsString()
  statut?: string;

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
