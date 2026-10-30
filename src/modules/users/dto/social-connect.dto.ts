import { IsOptional, IsString } from 'class-validator';

export class SocialConnectDto {
  @IsString()
  platform!: string;

  // 'mobile' quand la demande vient de l'app Capacitor : le callback OAuth doit alors
  // renvoyer vers le schéma natif postorico:// au lieu de la page web popup-close.
  @IsOptional()
  @IsString()
  source?: string;
}
