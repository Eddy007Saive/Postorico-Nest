import { IsEmail, IsIn, IsString, MaxLength } from 'class-validator';
import { ROLES_EQUIPE } from '../../../common/utils/acces-equipe.util';
import type { RoleEquipe } from '../../../common/utils/acces-equipe.util';

export class InviterDto {
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @IsIn(ROLES_EQUIPE)
  role!: RoleEquipe;
}

export class ChangerRoleDto {
  @IsIn(ROLES_EQUIPE)
  role!: RoleEquipe;
}

export class RejoindreDto {
  @IsString()
  @MaxLength(200)
  jeton!: string;
}
