
import {
  Injectable,
  ConflictException,
  BadRequestException,
  UnauthorizedException,
} from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';
import { RegisterDto } from './dto/register.dto.js';
import { UserRole, StoreStatus } from '../generated/prisma/client.js';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { createHmac, randomBytes } from 'node:crypto';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
  ) {}

  // CUSTOMER REGISTRATION
  async registerCustomer(dto: RegisterDto) {
    return this.register(dto, UserRole.CUSTOMER);
  }

  // VENDOR REGISTRATION
  async registerVendor(dto: RegisterDto) {
    const result = await this.register(dto, UserRole.VENDOR);

    return {
      message: 'Vendor account created. Store approval is required.',
      user: result.user,
    };
  }

  // COMMON REGISTRATION
  private async register(dto: RegisterDto, role: UserRole) {
    if (!dto.email && !dto.phone) {
      throw new BadRequestException(
        'Please provide an email address or phone number.',
      );
    }

    const email = dto.email?.trim().toLowerCase();
    const phone = dto.phone?.trim();

    const existingUser = await this.prisma.user.findFirst({
      where: {
        OR: [
          ...(email ? [{ email }] : []),
          ...(phone ? [{ phone }] : []),
        ],
      },
    });

    if (existingUser) {
      throw new ConflictException(
        'An account with this email or phone number already exists.',
      );
    }

    const passwordHash = await bcrypt.hash(dto.password, 12);

    const user = await this.prisma.user.create({
      data: {
        name: dto.name.trim(),
        email,
        phone,
        passwordHash,
        role,

        ...(role === UserRole.VENDOR
          ? {
              stores: {
                create: {
                  name: `${dto.name.trim()}'s Store`,
                  slug: `vendor-${randomBytes(12).toString('hex')}`,
                  status: StoreStatus.PENDING,
                },
              },
            }
          : {}),
      },

      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        role: true,
        createdAt: true,
      },
    });

    return {
      message: 'Account registered successfully.',
      user,
    };
  }

  // GENERATE REFRESH TOKEN
  private generateRefreshToken() {
    return randomBytes(64).toString('base64url');
  }

  // HASH REFRESH TOKEN USING A SECRET KEY
  private hashRefreshToken(token: string) {
    const secret = process.env.JWT_REFRESH_SECRET;

    if (!secret) {
      throw new Error('JWT_REFRESH_SECRET is not configured.');
    }

    return createHmac('sha256', secret)
      .update(token)
      .digest('hex');
  }

  // REFRESH TOKEN EXPIRATION
  private getRefreshTokenExpiry() {
    const duration = process.env.JWT_REFRESH_EXPIRES_IN || '7d';
    const match = duration.match(/^(\d+)([smhd])$/);

    if (!match) {
      throw new Error('Invalid JWT_REFRESH_EXPIRES_IN configuration.');
    }

    const amount = Number(match[1]);
    const unit = match[2];

    const multipliers: Record<string, number> = {
      s: 1000,
      m: 60 * 1000,
      h: 60 * 60 * 1000,
      d: 24 * 60 * 60 * 1000,
    };

    return new Date(Date.now() + amount * multipliers[unit]);
  }

  // CREATE ACCESS TOKEN
  private async createAccessToken(userId: string, role: UserRole) {
    return this.jwtService.signAsync({
      sub: userId,
      role,
    });
  }

  // LOGIN
  async login(identifier: string, password: string) {
    const normalizedIdentifier = identifier.trim().includes('@')
      ? identifier.trim().toLowerCase()
      : identifier.trim();

    const user = await this.prisma.user.findFirst({
      where: {
        OR: [
          { email: normalizedIdentifier },
          { phone: normalizedIdentifier },
        ],
      },
    });

    if (!user || !user.isActive) {
      throw new UnauthorizedException('Invalid credentials.');
    }

    const passwordMatches = await bcrypt.compare(
      password,
      user.passwordHash,
    );

    if (!passwordMatches) {
      throw new UnauthorizedException('Invalid credentials.');
    }

    const accessToken = await this.createAccessToken(
      user.id,
      user.role,
    );

    const refreshToken = this.generateRefreshToken();

    await this.prisma.refreshToken.create({
      data: {
        tokenHash: this.hashRefreshToken(refreshToken),
        userId: user.id,
        expiresAt: this.getRefreshTokenExpiry(),
      },
    });

    return {
      message: 'Login successful.',
      accessToken,
      refreshToken,
      tokenType: 'Bearer',
      expiresIn: '15m',
      refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d',
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        role: user.role,
      },
    };
  }

  // REFRESH ACCESS TOKEN AND ROTATE REFRESH TOKEN
  async refresh(refreshToken: string) {
    const tokenHash = this.hashRefreshToken(refreshToken);
    const now = new Date();

    return this.prisma.$transaction(async (tx) => {
      const storedToken = await tx.refreshToken.findUnique({
        where: { tokenHash },
        include: { user: true },
      });

      if (
        !storedToken ||
        storedToken.revokedAt ||
        storedToken.expiresAt <= now ||
        !storedToken.user.isActive
      ) {
        throw new UnauthorizedException(
          'Invalid or expired refresh token.',
        );
      }

      // Revoke the old token. Only one concurrent request can succeed.
      const revoked = await tx.refreshToken.updateMany({
        where: {
          id: storedToken.id,
          revokedAt: null,
          expiresAt: { gt: now },
        },
        data: {
          revokedAt: now,
        },
      });

      if (revoked.count !== 1) {
        throw new UnauthorizedException(
          'Refresh token has already been used.',
        );
      }

      // Create replacement refresh token
      const newRefreshToken = this.generateRefreshToken();

      await tx.refreshToken.create({
        data: {
          tokenHash: this.hashRefreshToken(newRefreshToken),
          userId: storedToken.userId,
          expiresAt: this.getRefreshTokenExpiry(),
        },
      });

      const accessToken = await this.createAccessToken(
        storedToken.userId,
        storedToken.user.role,
      );

      return {
        message: 'Token refreshed successfully.',
        accessToken,
        refreshToken: newRefreshToken,
        tokenType: 'Bearer',
        expiresIn: '15m',
        refreshExpiresIn:
          process.env.JWT_REFRESH_EXPIRES_IN || '7d',
      };
    });
  }


    // GET CURRENT AUTHENTICATED USER
  async getMe(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        role: true,
        isActive: true,
        emailVerifiedAt: true,
        phoneVerifiedAt: true,
        createdAt: true,
      },
    });

    if (!user || !user.isActive) {
      throw new UnauthorizedException('User account is unavailable.');
    }

    return {
      message: 'User profile retrieved successfully.',
      user,
    };
  }

  
  // LOGOUT
  async logout(refreshToken: string) {
    const tokenHash = this.hashRefreshToken(refreshToken);

    await this.prisma.refreshToken.updateMany({
      where: {
        tokenHash,
        revokedAt: null,
      },
      data: {
        revokedAt: new Date(),
      },
    });

    return {
      message: 'Logout successful.',
    };
  }
}
