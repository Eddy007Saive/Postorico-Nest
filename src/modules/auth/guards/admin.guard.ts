import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Request } from 'express';
import { JwtAuthGuard } from './jwt-auth.guard';
import { JwtPayload } from '../auth.service';

/**
 * Port direct de backend/dependencies.py::verify_admin_token.
 * Rejoue d'abord JwtAuthGuard (jeton + empreinte), puis exige is_admin=true.
 */
@Injectable()
export class AdminGuard extends JwtAuthGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    await super.canActivate(context);
    const request = context.switchToHttp().getRequest<Request & { user: JwtPayload }>();
    if (!request.user?.is_admin) {
      throw new ForbiddenException('Admin access required');
    }
    return true;
  }
}
