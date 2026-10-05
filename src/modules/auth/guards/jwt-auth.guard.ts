import * as Sentry from '@sentry/nestjs';
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';
import { AuthService, JwtPayload } from '../auth.service';

/**
 * Port direct de backend/dependencies.py::verify_token.
 * Vérifie le jeton, puis qu'il n'a pas été révoqué : mot de passe changé depuis son
 * émission (empreinte `fp`), ou déconnexion posée après (`iat` < sessions_invalidees_le).
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly authService: AuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const token = this.extractToken(request);
    if (!token) {
      throw new UnauthorizedException('Missing token');
    }

    // RFC 7515 exige le rejet d'un jeton dont l'en-tête « crit » liste une extension que le
    // vérificateur ne comprend pas — cette appli n'en implémente aucune, donc tout « crit »
    // non vide est refusé. `jsonwebtoken` (contrairement à PyJWT depuis son correctif
    // CVE-2026-32597) ne fait pas ce contrôle lui-même : on le pose ici, avant vérification.
    const decoded = this.jwtService.decode(token, { complete: true }) as { header?: { crit?: unknown } } | null;
    if (decoded?.header?.crit) {
      throw new UnauthorizedException('Invalid or expired token');
    }

    let payload: JwtPayload;
    try {
      payload = await this.jwtService.verifyAsync<JwtPayload>(token);
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }

    // Invalidation : mot de passe modifié (empreinte `fp`) ou déconnexion posée après
    // l'émission du jeton (`iat` < users.sessions_invalidees_le).
    if (payload.telegram_id) {
      const valid = await this.authService.sessionValid(payload.telegram_id, payload.fp, payload.iat);
      if (!valid) {
        throw new UnauthorizedException('Session expirée');
      }
    }

    (request as Request & { user: JwtPayload }).user = payload;
    // Les erreurs de la requête sont rattachées au compte (id interne seulement, jamais l'email).
    if (payload.telegram_id) Sentry.setUser({ id: payload.telegram_id });
    return true;
  }

  private extractToken(request: Request): string | null {
    const header = request.headers.authorization;
    if (!header) return null;
    const [type, token] = header.split(' ');
    return type === 'Bearer' ? token : null;
  }
}
