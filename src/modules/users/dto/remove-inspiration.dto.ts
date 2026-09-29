import { IsString } from 'class-validator';

export class RemoveInspirationDto {
  @IsString()
  url!: string;
}
