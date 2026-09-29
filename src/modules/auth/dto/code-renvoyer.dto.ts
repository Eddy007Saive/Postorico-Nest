import { IsString } from 'class-validator';

/** Port direct de backend/models/auth.py::CodeRenvoyer. */
export class CodeRenvoyerDto {
  @IsString()
  jeton: string;
}
