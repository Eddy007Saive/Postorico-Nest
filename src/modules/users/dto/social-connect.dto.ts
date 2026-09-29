import { IsString } from 'class-validator';

export class SocialConnectDto {
  @IsString()
  platform!: string;
}
