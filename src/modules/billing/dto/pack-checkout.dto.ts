import { IsString } from 'class-validator';

export class PackCheckoutDto {
  @IsString()
  pack_id!: string;
}
