import { Module } from '@nestjs/common';
import { RateLimitService } from './rate-limit.service';

/** Déclare RateLimitService UNE SEULE FOIS pour toute l'app. Avant ce module, auth/editeur/reel
 * déclaraient chacun leur propre instance, donc chacun son propre état en mémoire — les compteurs
 * anti-bruteforce n'étaient donc pas réellement partagés entre modules. */
@Module({
  providers: [RateLimitService],
  exports: [RateLimitService],
})
export class RateLimitModule {}
