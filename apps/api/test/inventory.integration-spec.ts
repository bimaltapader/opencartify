import 'reflect-metadata';

import { BadRequestException } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';

import {
  InventoryMovementType,
  PrismaClient,
  ProductStatus,
  StoreStatus,
  UserRole,
} from '../src/generated/prisma/client.js';
import { InventoryService } from '../src/inventory/inventory.service.js';

const databaseUrl = process.env.DATABASE_URL!;
const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: databaseUrl }),
});
const inventoryService = new InventoryService(prisma as never);
const lockPool = new Pool({ connectionString: databaseUrl });

type Fixture = {
  userId: string;
  storeId: string;
  productId: string;
  inventoryId: string;
};

const fixtures: Fixture[] = [];

async function createFixture(quantity = 10, reserved = 3): Promise<Fixture> {
  const suffix = randomUUID();
  const user = await prisma.user.create({
    data: {
      name: `Inventory Integration ${suffix}`,
      email: `inventory-${suffix}@integration.test`,
      passwordHash: 'integration-test-only',
      role: UserRole.VENDOR,
    },
  });
  const store = await prisma.store.create({
    data: {
      ownerId: user.id,
      name: `Inventory Store ${suffix}`,
      slug: `inventory-store-${suffix}`,
      status: StoreStatus.ACTIVE,
    },
  });
  const product = await prisma.product.create({
    data: {
      storeId: store.id,
      name: `Inventory Product ${suffix}`,
      slug: `inventory-product-${suffix}`,
      sku: `inventory-sku-${suffix}`,
      price: 10,
      status: ProductStatus.ACTIVE,
      inventory: {
        create: {
          quantity,
          reserved,
          lowStockThreshold: 5,
        },
      },
    },
    select: { id: true, inventory: { select: { id: true } } },
  });

  const fixture = {
    userId: user.id,
    storeId: store.id,
    productId: product.id,
    inventoryId: product.inventory!.id,
  };
  fixtures.push(fixture);
  return fixture;
}

async function removeFixture(fixture: Fixture) {
  await prisma.inventoryMovement.deleteMany({
    where: { inventoryId: fixture.inventoryId },
  });
  await prisma.inventory.deleteMany({ where: { id: fixture.inventoryId } });
  await prisma.product.deleteMany({ where: { id: fixture.productId } });
  await prisma.store.deleteMany({ where: { id: fixture.storeId } });
  await prisma.user.deleteMany({ where: { id: fixture.userId } });
}

async function delay(milliseconds: number) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

beforeAll(async () => {
  await prisma.$connect();
});

afterEach(async () => {
  while (fixtures.length > 0) {
    const fixture = fixtures.pop();
    if (fixture) {
      await removeFixture(fixture);
    }
  }

  await prisma.$executeRawUnsafe(
    'DROP TRIGGER IF EXISTS inventory_movement_integration_failure ON "InventoryMovement"',
  );
  await prisma.$executeRawUnsafe(
    'DROP FUNCTION IF EXISTS inventory_movement_integration_failure()',
  );
});

afterAll(async () => {
  await lockPool.end();
  await prisma.$disconnect();
});

describe('Inventory PostgreSQL integration', () => {
  it('waits on a real PostgreSQL row lock before adjusting inventory', async () => {
    const fixture = await createFixture();
    const lockClient = await lockPool.connect();
    let completed = false;

    try {
      await lockClient.query('BEGIN');
      await lockClient.query(
        'SELECT "id" FROM "Inventory" WHERE "id" = $1 FOR UPDATE',
        [fixture.inventoryId],
      );

      const adjustment = inventoryService
        .adjustInventory(fixture.userId, fixture.productId, {
          quantityChange: 1,
          reason: 'Locked stock count',
        })
        .finally(() => {
          completed = true;
        });

      await delay(150);
      expect(completed).toBe(false);

      await lockClient.query('COMMIT');
      await adjustment;
    } finally {
      await lockClient.query('ROLLBACK').catch(() => undefined);
      lockClient.release();
    }

    const inventory = await prisma.inventory.findUniqueOrThrow({
      where: { id: fixture.inventoryId },
      include: { movements: true },
    });
    expect(inventory.quantity).toBe(11);
    expect(inventory.movements).toHaveLength(1);
  });

  it('serializes concurrent valid adjustments without lost updates', async () => {
    const fixture = await createFixture();

    await Promise.all([
      inventoryService.adjustInventory(fixture.userId, fixture.productId, {
        quantityChange: 5,
        reason: 'Inbound delivery',
      }),
      inventoryService.adjustInventory(fixture.userId, fixture.productId, {
        quantityChange: -2,
        reason: 'Damaged units',
      }),
    ]);

    const inventory = await prisma.inventory.findUniqueOrThrow({
      where: { id: fixture.inventoryId },
      include: { movements: true },
    });
    expect(inventory.quantity).toBe(13);
    expect(inventory.movements).toHaveLength(2);
    expect(
      inventory.movements.every(
        (movement) => movement.type === InventoryMovementType.STOCK_ADJUSTMENT,
      ),
    ).toBe(true);

    const first = inventory.movements.find(
      (movement) => movement.quantityBefore === 10,
    );
    expect(first).toBeDefined();
    const second = inventory.movements.find(
      (movement) => movement.id !== first!.id,
    );
    expect(second!.quantityBefore).toBe(first!.quantityAfter);
    expect(second!.quantityAfter).toBe(13);
    expect(
      inventory.movements.map((movement) => movement.quantityChange).sort(),
    ).toEqual([-2, 5]);
  });

  it('rolls back the inventory update when movement insertion fails', async () => {
    const fixture = await createFixture();

    await prisma.$executeRawUnsafe(`
      CREATE FUNCTION inventory_movement_integration_failure()
      RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'inventory movement failure for integration test';
      END;
      $$ LANGUAGE plpgsql;
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER inventory_movement_integration_failure
      BEFORE INSERT ON "InventoryMovement"
      FOR EACH ROW EXECUTE FUNCTION inventory_movement_integration_failure();
    `);

    await expect(
      inventoryService.adjustInventory(fixture.userId, fixture.productId, {
        quantityChange: 1,
        reason: 'Rollback verification',
      }),
    ).rejects.toThrow();

    const inventory = await prisma.inventory.findUniqueOrThrow({
      where: { id: fixture.inventoryId },
      include: { movements: true },
    });
    expect(inventory.quantity).toBe(10);
    expect(inventory.movements).toHaveLength(0);
  });

  it('protects reserved stock without recording an incorrect movement', async () => {
    const fixture = await createFixture(10, 7);

    await expect(
      inventoryService.adjustInventory(fixture.userId, fixture.productId, {
        quantityChange: -4,
        reason: 'Reserved stock protection',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    const inventory = await prisma.inventory.findUniqueOrThrow({
      where: { id: fixture.inventoryId },
      include: { movements: true },
    });
    expect(inventory.quantity).toBe(10);
    expect(inventory.reserved).toBe(7);
    expect(inventory.movements).toHaveLength(0);
  });
});
