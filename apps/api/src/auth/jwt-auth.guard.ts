
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';

import { JwtService } from '@nestjs/jwt';

interface AuthenticatedRequest {
  headers: {
    authorization?: string;
  };
  user?: {
    sub: string;
    role: string;
  };
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly jwtService: JwtService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request =
      context.switchToHttp().getRequest<AuthenticatedRequest>();

    const authorization = request.headers.authorization;

    if (!authorization || !authorization.startsWith('Bearer ')) {
      throw new UnauthorizedException(
        'Access token is required.',
      );
    }

    const token = authorization.substring(7).trim();

    if (!token) {
      throw new UnauthorizedException(
        'Access token is required.',
      );
    }

    try {
      const payload = await this.jwtService.verifyAsync<{
        sub: string;
        role: string;
      }>(token);

      if (!payload.sub || !payload.role) {
        throw new UnauthorizedException('Invalid access token.');
      }

      request.user = {
        sub: payload.sub,
        role: payload.role,
      };

      return true;
    } catch {
      throw new UnauthorizedException(
        'Invalid or expired access token.',
      );
    }
  }
}
