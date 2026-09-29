import { IsString, MinLength } from 'class-validator';

export class CreateAccountDto {
  @IsString()
  nom!: string;

  @IsString()
  email!: string;

  @IsString()
  @MinLength(6)
  password!: string;
}
