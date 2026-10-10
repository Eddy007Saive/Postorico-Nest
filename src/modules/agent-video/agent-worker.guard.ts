import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { timingSafeEqual } from 'crypto';
import type { Request } from 'express';
import { AgentVideoService } from './agent-video.service';

/** Compare deux chaînes en temps constant (même longueur exigée par timingSafeEqual). */
export function jetonValide(attendu: string, recu: string | undefined | null): boolean {
  if (!attendu || !recu) return false;
  const a = Buffer.from(attendu);
  const b = Buffer.from(recu);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Routes du worker du VPS : `Authorization: Bearer <AGENT_VIDEO_WORKER_TOKEN>`.
 * Refuse TOUT si le jeton n'est pas configuré (contrairement au webhook Zernio historique, qui
 * acceptait les appels non signés quand son secret était vide).
 */
@Injectable()
export class AgentWorkerGuard implements CanActivate {
  constructor(private readonly service: AgentVideoService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const entete = req.headers.authorization || '';
    const recu = entete.startsWith('Bearer ') ? entete.slice(7).trim() : '';
    if (!jetonValide(this.service.jeton, recu)) throw new UnauthorizedException('Jeton du worker invalide');
    return true;
  }
}
