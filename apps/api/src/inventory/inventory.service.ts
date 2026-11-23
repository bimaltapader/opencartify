import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import {
  InventoryMovementType,
  Prisma,
} from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AdjustInventoryDto } from './dto/adjust-inventory.dto.js';
import { InventoryMovementsQueryDto } from './dto/inventory-movements-query.dto.js';

type LockedProduct = { id: string };

type LockedInventory = {
  id: string;
  quantity: number;
  reserved: number;
  lowStockThreshold: number;
};

@Injectable()
export class InventoryService {
  constructor(private readonly prisma: PrismaService) {}

  async getMyInventory(userId: string) {
    const products = await this.prisma.product.findMany({
      where: {
        deletedAt: null,
        store: { ownerId: userId },
      },
      select: {
        id: true,
        name: true,
        sku: true,
        barcode: true,
        status: true,
        images: {
          where: { isPrimary: true },
          select: { imageUrl: true, altText: true },
          take: 1,
        },
        inventory: {
          select: {
            id: true,
            quantity: true,
            reserved: true,
            lowStockThreshold: true,
            updatedAt: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    const inventory = products.map((product) => {
      const record = product.inventory;

      if (!record) {
        return {
          product: {
            id: product.id,
            name: product.name,
            sku: product.sku,
            barcode: product.barcode,
            status: product.status,
            primaryImage: product.images[0] ?? null,
          },
          inventoryId: null,
          quantity: null,
          reserved: null,
          availableStock: null,
          lowStockThreshold: null,
          isLowStock: null,
          hasInventory: false,
          inventoryWarning: 'Inventory record is missing.',
          updatedAt: null,
        };
      }

      const quantity = record?.quantity ?? 0;
      const reserved = record?.reserved ?? 0;
      const availableStock = quantity - reserved;

      return {
        product: {
          id: product.id,
          name: product.name,
          sku: product.sku,
          barcode: product.barcode,
          status: product.status,
          primaryImage: product.images[0] ?? null,
        },
        inventoryId: record?.id ?? null,
        quantity,
        reserved,
        availableStock,
        lowStockThreshold: record?.lowStockThreshold ?? null,
        isLowStock: availableStock <= record.lowStockThreshold,
        hasInventory: true,
        inventoryWarning: null,
        updatedAt: record?.updatedAt ?? null,
      };
    });

    return {
      message: 'Inventory retrieved successfully.',
      total: inventory.length,
      inventory,
    };
  }

  async getMovements(
    userId: string,
    productId: string,
    query: InventoryMovementsQueryDto,
  ) {
    const inventory = await this.prisma.inventory.findFirst({
      where: {
        productId,
        product: {
          deletedAt: null,
          store: { ownerId: userId },
        },
      },
      select: {
        id: true,
        product: { select: { id: true, name: true, sku: true } },
      },
    });

    if (!inventory) {
      throw new NotFoundException('Inventory not found.');
    }

    const skip = (query.page - 1) * query.limit;
    const [movements, total] = await this.prisma.$transaction([
      this.prisma.inventoryMovement.findMany({
        where: { inventoryId: inventory.id },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip,
        take: query.limit,
        select: {
          id: true,
          type: true,
          quantityChange: true,
          quantityBefore: true,
          quantityAfter: true,
          reason: true,
          reference: true,
          createdAt: true,
          performedBy: { select: { id: true, name: true } },
        },
      }),
      this.prisma.inventoryMovement.count({
        where: { inventoryId: inventory.id },
      }),
    ]);

    return {
      message: 'Inventory movements retrieved successfully.',
      product: inventory.product,
      movements,
      pagination: {
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.ceil(total / query.limit),
      },
    };
  }

  async adjustInventory(
    userId: string,
    productId: string,
    dto: AdjustInventoryDto,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const products = await tx.$queryRaw<LockedProduct[]>(Prisma.sql`
        SELECT p."id"
        FROM "Product" AS p
        INNER JOIN "Store" AS s ON s."id" = p."storeId"
        WHERE p."id" = ${productId}
          AND s."ownerId" = ${userId}
          AND p."deletedAt" IS NULL
        FOR UPDATE OF p
      `);

      if (products.length === 0) {
        throw new NotFoundException('Product not found.');
      }

      const inventories = await tx.$queryRaw<LockedInventory[]>(Prisma.sql`
        SELECT
          i."id",
          i."quantity",
          i."reserved",
          i."lowStockThreshold"
        FROM "Inventory" AS i
        WHERE i."productId" = ${productId}
        FOR UPDATE
      `);

      const inventory = inventories[0];

      if (!inventory) {
        throw new NotFoundException('Inventory not found.');
      }

      const quantityAfter = inventory.quantity + dto.quantityChange;

      if (quantityAfter < 0) {
        throw new BadRequestException('Inventory quantity cannot be negative.');
      }

      if (quantityAfter < inventory.reserved) {
        throw new BadRequestException(
          'Inventory quantity cannot be lower than reserved stock.',
        );
      }

      const updatedInventory = await tx.inventory.update({
        where: { id: inventory.id },
        data: { quantity: quantityAfter },
        select: {
          id: true,
          quantity: true,
          reserved: true,
          lowStockThreshold: true,
          updatedAt: true,
        },
      });

      const movement = await tx.inventoryMovement.create({
        data: {
          inventoryId: inventory.id,
          performedById: userId,
          type: InventoryMovementType.STOCK_ADJUSTMENT,
          quantityChange: dto.quantityChange,
          quantityBefore: inventory.quantity,
          quantityAfter,
          reason: dto.reason,
        },
        select: {
          id: true,
          type: true,
          quantityChange: true,
          quantityBefore: true,
          quantityAfter: true,
          reason: true,
          createdAt: true,
          performedById: true,
        },
      });

      const availableStock =
        updatedInventory.quantity - updatedInventory.reserved;

      return {
        message: 'Inventory adjusted successfully.',
        inventory: {
          ...updatedInventory,
          availableStock,
          isLowStock:
            availableStock <= updatedInventory.lowStockThreshold,
        },
        movement,
      };
    });
  }
}
