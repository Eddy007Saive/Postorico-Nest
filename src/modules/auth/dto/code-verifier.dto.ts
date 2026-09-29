import { IsBoolean, IsOptional, IsString } from 'class-validator';

/** Port direct de backend/models/auth.py::CodeVerifier. */
export class CodeVerifierDto {
  @IsString()
  jeton: string; // jeton d'attente rendu par /login quand code_requis

  @IsString()
  code: string;

  @IsOptional()
  @IsBoolean()
  confiance?: boolean = false; // marquer cet appareil de confiance (30 jours)
}
