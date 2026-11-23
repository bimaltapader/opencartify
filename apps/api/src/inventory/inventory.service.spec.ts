import {
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';

import { InventoryMovementType } from '../generated/prisma/client.js';
import { InventoryService } from './inventory.service.js';

const vendorId = 'vendor-id';
const productId = 'product-id';

describe('InventoryService', () => {
  let prisma: Record<string, any>;
  let transaction: Record<string, any>;
  let service: InventoryService;

  const lockedProduct = [{ id: productId }];
  const inventory = {
    id: 'inventory-id',
    quantity: 10,
    reserved: 3,
    lowStockThreshold: 5,
  };

  beforeEach(() => {
    transaction = {
      $queryRaw: vi.fn(),
      inventory: { update: vi.fn() },
      inventoryMovement: { create: vi.fn() },
    };
    prisma = {
      product: { findMany: vi.fn() },
      inventory: { findFirst: vi.fn() },
      inventoryMovement: { findMany: vi.fn(), count: vi.fn() },
      $transaction: vi.fn(async (operation: unknown) => {
        if (typeof operation === 'function') {
          return operation(transaction);
        }

        return Promise.all(operation as Promise<unknown>[]);
      }),
    };
    service = new InventoryService(prisma as never);
  });

  it('calculates available and low stock values for owned active products', async () => {
    prisma.product.findMany.mockResolvedValue([
      {
        id: productId,
        name: 'Product',
        sku: 'SKU-1',
        barcode: null,
        status: 'ACTIVE',
        images: [{ imageUrl: 'https://example.test/product.jpg', altText: 'Product' }],
        inventory: { ...inventory, updatedAt: new Date() },
      },
    ]);

    const result = await service.getMyInventory(vendorId);

    expect(prisma.product.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          deletedAt: null,
          store: { ownerId: vendorId },
        },
      }),
    );
    expect(result.inventory[0]).toMatchObject({
      quantity: 10,
      reserved: 3,
      availableStock: 7,
      isLowStock: false,
      hasInventory: true,
    });
  });

  it('handles products without inventory records without exposing invalid values', async () => {
    prisma.product.findMany.mockResolvedValue([
      {
        id: productId,
        name: 'Product',
        sku: 'SKU-1',
        barcode: null,
        status: 'DRAFT',
        images: [],
        inventory: null,
      },
    ]);

    const result = await service.getMyInventory(vendorId);

    expect(result.inventory[0]).toMatchObject({
      inventoryId: null,
      quantity: null,
      reserved: null,
      availableStock: null,
      isLowStock: null,
      hasInventory: false,
      inventoryWarning: 'Inventory record is missing.',
    });
  });

  it('marks stock as low when available stock reaches the threshold', async () => {
    prisma.product.findMany.mockResolvedValue([
      {
        id: productId,
        name: 'Product',
        sku: 'SKU-1',
        barcode: null,
        status: 'ACTIVE',
        images: [],
        inventory: {
          ...inventory,
          quantity: 8,
          reserved: 3,
          lowStockThreshold: 5,
          updatedAt: new Date(),
        },
      },
    ]);

    const result = await service.getMyInventory(vendorId);

    expect(result.inventory[0]).toMatchObject({
      availableStock: 5,
      isLowStock: true,
      hasInventory: true,
      inventoryWarning: null,
    });
  });

  it('returns newest-first movement history with pagination', async () => {
    prisma.inventory.findFirst.mockResolvedValue({
      id: 'inventory-id',
      product: { id: productId, name: 'Product', sku: 'SKU-1' },
    });
    prisma.inventoryMovement.findMany.mockResolvedValue([{ id: 'newest' }]);
    prisma.inventoryMovement.count.mockResolvedValue(21);

    const result = await service.getMovements(vendorId, productId, {
      page: 2,
      limit: 10,
    });

    expect(prisma.inventory.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          productId,
          product: {
            deletedAt: null,
            store: { ownerId: vendorId },
          },
        },
      }),
    );
    expect(prisma.inventoryMovement.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: 10,
        take: 10,
      }),
    );
    expect(result.pagination).toEqual({
      page: 2,
      limit: 10,
      total: 21,
      totalPages: 3,
    });
  });

  it('rejects movement history for products outside the vendor ownership scope', async () => {
    prisma.inventory.findFirst.mockResolvedValue(null);

    await expect(
      service.getMovements(vendorId, productId, { page: 1, limit: 20 }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('adjusts positive stock and writes an accurate ledger entry', async () => {
    transaction.$queryRaw
      .mockResolvedValueOnce(lockedProduct)
      .mockResolvedValueOnce([inventory]);
    transaction.inventory.update.mockResolvedValue({
      id: inventory.id,
      quantity: 15,
      reserved: 3,
      lowStockThreshold: 5,
      updatedAt: new Date(),
    });
    transaction.inventoryMovement.create.mockResolvedValue({ id: 'movement-id' });

    const result = await service.adjustInventory(vendorId, productId, {
      quantityChange: 5,
      reason: 'Purchase delivery',
    });

    expect(transaction.$queryRaw).toHaveBeenCalledTimes(2);
    expect(transaction.inventory.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { quantity: 15 } }),
    );
    expect(transaction.inventoryMovement.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          inventoryId: inventory.id,
          performedById: vendorId,
          type: InventoryMovementType.STOCK_ADJUSTMENT,
          quantityChange: 5,
          quantityBefore: 10,
          quantityAfter: 15,
          reason: 'Purchase delivery',
        }),
      }),
    );
    expect(result.inventory).toMatchObject({
      quantity: 15,
      availableStock: 12,
      isLowStock: false,
    });
  });

  it('allows a negative adjustment that remains above reserved stock', async () => {
    transaction.$queryRaw
      .mockResolvedValueOnce(lockedProduct)
      .mockResolvedValueOnce([inventory]);
    transaction.inventory.update.mockResolvedValue({
      id: inventory.id,
      quantity: 7,
      reserved: 3,
      lowStockThreshold: 5,
      updatedAt: new Date(),
    });
    transaction.inventoryMovement.create.mockResolvedValue({ id: 'movement-id' });

    await service.adjustInventory(vendorId, productId, {
      quantityChange: -3,
      reason: 'Damaged stock',
    });

    expect(transaction.inventoryMovement.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          quantityChange: -3,
          quantityBefore: 10,
          quantityAfter: 7,
        }),
      }),
    );
  });

  it('rejects deleted or non-owned products before adjusting inventory', async () => {
    transaction.$queryRaw.mockResolvedValueOnce([]);

    await expect(
      service.adjustInventory(vendorId, productId, {
        quantityChange: 1,
        reason: 'Stock count',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(transaction.inventory.update).not.toHaveBeenCalled();
  });

  it('rejects products without inventory records', async () => {
    transaction.$queryRaw
      .mockResolvedValueOnce(lockedProduct)
      .mockResolvedValueOnce([]);

    await expect(
      service.adjustInventory(vendorId, productId, {
        quantityChange: 1,
        reason: 'Stock count',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(transaction.inventoryMovement.create).not.toHaveBeenCalled();
  });

  it('prevents inventory from becoming negative', async () => {
    transaction.$queryRaw
      .mockResolvedValueOnce(lockedProduct)
      .mockResolvedValueOnce([{ ...inventory, reserved: 0 }]);

    await expect(
      service.adjustInventory(vendorId, productId, {
        quantityChange: -11,
        reason: 'Stock correction',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(transaction.inventory.update).not.toHaveBeenCalled();
  });

  it('prevents inventory from dropping below reserved stock', async () => {
    transaction.$queryRaw
      .mockResolvedValueOnce(lockedProduct)
      .mockResolvedValueOnce([inventory]);

    await expect(
      service.adjustInventory(vendorId, productId, {
        quantityChange: -8,
        reason: 'Stock correction',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(transaction.inventory.update).not.toHaveBeenCalled();
  });
});
