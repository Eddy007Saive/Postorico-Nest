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
 * Vérifie le jeton, puis l'empreinte du mot de passe (`fp`) : si le mot de passe a changé
 * depuis l'émission du jeton, la session est invalidée même si le jeton n'a pas expiré.
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

    // Jetons émis avant l'empreinte n'en ont pas -> tolérés jusqu'à expiration.
    if (payload.fp && payload.telegram_id) {
      const valid = await this.authService.sessionValid(payload.telegram_id, payload.fp);
      if (!valid) {
        throw new UnauthorizedException('Session expirée (mot de passe modifié)');
      }
    }

    (request as Request & { user: JwtPayload }).user = payload;
    return true;
  }

  private extractToken(request: Request): string | null {
    const header = request.headers.authorization;
    if (!header) return null;
    const [type, token] = header.split(' ');
    return type === 'Bearer' ? token : null;
  }
}
