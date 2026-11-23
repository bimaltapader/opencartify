import 'reflect-metadata';

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';

import {
  CartStatus,
  PrismaClient,
  ProductStatus,
  StoreStatus,
  UserRole,
} from '../src/generated/prisma/client.js';
import { CartService } from '../src/cart/cart.service.js';

const databaseUrl = process.env.DATABASE_URL!;
const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: databaseUrl }),
});
const cartService = new CartService(prisma as never);
const pool = new Pool({ connectionString: databaseUrl });

type Fixture = {
  vendorId: string;
  customerId: string;
  customer2Id: string;
  storeId: string;
  productId: string;
  inventoryId: string;
};

const fixtures: Fixture[] = [];

async function createFixture(quantity = 10, reserved = 2): Promise<Fixture> {
  const suffix = randomUUID();

  const vendor = await prisma.user.create({
    data: {
      name: `Vendor ${suffix}`,
      email: `vendor-${suffix}@integration.test`,
      passwordHash: 'integration-test-only',
      role: UserRole.VENDOR,
    },
  });

  const customer = await prisma.user.create({
    data: {
      name: `Customer ${suffix}`,
      email: `customer-${suffix}@integration.test`,
      passwordHash: 'integration-test-only',
      role: UserRole.CUSTOMER,
    },
  });

  const customer2 = await prisma.user.create({
    data: {
      name: `Customer2 ${suffix}`,
      email: `customer2-${suffix}@integration.test`,
      passwordHash: 'integration-test-only',
      role: UserRole.CUSTOMER,
    },
  });

  const store = await prisma.store.create({
    data: {
      ownerId: vendor.id,
      name: `Store ${suffix}`,
      slug: `store-${suffix}`,
      status: StoreStatus.ACTIVE,
    },
  });

  const product = await prisma.product.create({
    data: {
      storeId: store.id,
      name: `Product ${suffix}`,
      slug: `product-${suffix}`,
      sku: `sku-${suffix}`,
      price: 25,
      status: ProductStatus.ACTIVE,
      isPublished: true,
      inventory: {
        create: {
          quantity,
          reserved,
          lowStockThreshold: 2,
        },
      },
    },
    select: { id: true, inventory: { select: { id: true } } },
  });

  const fixture: Fixture = {
    vendorId: vendor.id,
    customerId: customer.id,
    customer2Id: customer2.id,
    storeId: store.id,
    productId: product.id,
    inventoryId: product.inventory!.id,
  };

  fixtures.push(fixture);
  return fixture;
}

async function removeFixture(fixture: Fixture) {
  await prisma.cartItem.deleteMany({
    where: {
      OR: [
        { product: { id: fixture.productId } },
        { cart: { customerId: fixture.customerId } },
        { cart: { customerId: fixture.customer2Id } },
      ],
    },
  });
  await prisma.cart.deleteMany({
    where: {
      customerId: { in: [fixture.customerId, fixture.customer2Id] },
    },
  });
  await prisma.inventory.deleteMany({ where: { id: fixture.inventoryId } });
  await prisma.product.deleteMany({ where: { id: fixture.productId } });
  await prisma.store.deleteMany({ where: { id: fixture.storeId } });
  await prisma.user.deleteMany({
    where: {
      id: { in: [fixture.vendorId, fixture.customerId, fixture.customer2Id] },
    },
  });
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
});

afterAll(async () => {
  await pool.end();
  await prisma.$disconnect();
});

describe('Cart PostgreSQL integration', () => {
  describe('A. Partial unique index', () => {
    it('rejects two ACTIVE carts for the same customer', async () => {
      const fixture = await createFixture();

      // First ACTIVE cart
      await prisma.cart.create({
        data: {
          customerId: fixture.customerId,
          status: CartStatus.ACTIVE,
        },
      });

      // Second ACTIVE cart for the same customer must fail via partial unique index
      await expect(
        prisma.cart.create({
          data: {
            customerId: fixture.customerId,
            status: CartStatus.ACTIVE,
          },
        }),
      ).rejects.toThrow();
    });

    it('permits multiple non-ACTIVE carts for the same customer', async () => {
      const fixture = await createFixture();

      // One active cart
      const active = await prisma.cart.create({
        data: {
          customerId: fixture.customerId,
          status: CartStatus.ACTIVE,
        },
      });

      // First CHECKED_OUT cart
      const checkedOut1 = await prisma.cart.create({
        data: {
          customerId: fixture.customerId,
          status: CartStatus.CHECKED_OUT,
        },
      });

      // Second CHECKED_OUT cart
      const checkedOut2 = await prisma.cart.create({
        data: {
          customerId: fixture.customerId,
          status: CartStatus.CHECKED_OUT,
        },
      });

      // Third ABANDONED cart
      const abandoned = await prisma.cart.create({
        data: {
          customerId: fixture.customerId,
          status: CartStatus.ABANDONED,
        },
      });

      expect(active.id).toBeDefined();
      expect(checkedOut1.id).toBeDefined();
      expect(checkedOut2.id).toBeDefined();
      expect(abandoned.id).toBeDefined();

      const allCarts = await prisma.cart.findMany({
        where: { customerId: fixture.customerId },
      });
      expect(allCarts).toHaveLength(4);
    });
  });

  describe('B. Quantity constraint', () => {
    it('rejects CartItem quantity of zero or negative at database level', async () => {
      const fixture = await createFixture();
      const cart = await cartService.getOrCreateActiveCart(fixture.customerId);

      // Quantity = 0 directly in database
      await expect(
        pool.query(
          `INSERT INTO "CartItem" ("id", "cartId", "productId", "quantity", "createdAt", "updatedAt")
           VALUES (gen_random_uuid(), $1, $2, 0, NOW(), NOW())`,
          [cart.id, fixture.productId],
        ),
      ).rejects.toThrow(/CartItem_quantity_positive/);

      // Quantity = -1 directly in database
      await expect(
        pool.query(
          `INSERT INTO "CartItem" ("id", "cartId", "productId", "quantity", "createdAt", "updatedAt")
           VALUES (gen_random_uuid(), $1, $2, -1, NOW(), NOW())`,
          [cart.id, fixture.productId],
        ),
      ).rejects.toThrow(/CartItem_quantity_positive/);
    });
  });

  describe('C. Product deletion (ON DELETE RESTRICT)', () => {
    it('verifies ON DELETE RESTRICT for products referenced by cart items', async () => {
      const fixture = await createFixture();
      await cartService.addItem(fixture.customerId, {
        productId: fixture.productId,
        quantity: 1,
      });

      // Attempting to hard-delete the referenced product must fail with foreign key restrict
      await expect(
        pool.query('DELETE FROM "Product" WHERE "id" = $1', [
          fixture.productId,
        ]),
      ).rejects.toThrow();

      // Verify product is still in database
      const product = await prisma.product.findUnique({
        where: { id: fixture.productId },
      });
      expect(product).not.toBeNull();
    });
  });

  describe('D. Concurrent cart additions', () => {
    it('serializes simultaneous additions of same product without lost updates', async () => {
      const fixture = await createFixture(10, 2); // available = 8

      // Two simultaneous additions of quantity 2
      const [res1, res2] = await Promise.all([
        cartService.addItem(fixture.customerId, {
          productId: fixture.productId,
          quantity: 2,
        }),
        cartService.addItem(fixture.customerId, {
          productId: fixture.productId,
          quantity: 2,
        }),
      ]);

      expect(res1.item).toBeDefined();
      expect(res2.item).toBeDefined();

      // Verify cart has exactly 1 CartItem row with quantity 4 (2 + 2)
      const cart = await cartService.getCart(fixture.customerId);
      expect(cart.cart.items).toHaveLength(1);
      expect(cart.cart.items[0].quantity).toBe(4);
      expect(cart.cart.summary.totalQuantity).toBe(4);
      expect(cart.cart.summary.subtotal).toBe(100); // 4 * 25

      // Confirm inventory quantities and reserved were NOT modified
      const inventory = await prisma.inventory.findUniqueOrThrow({
        where: { id: fixture.inventoryId },
      });
      expect(inventory.quantity).toBe(10);
      expect(inventory.reserved).toBe(2);
    });

    it('rejects additions when combined quantity would exceed available stock', async () => {
      const fixture = await createFixture(5, 0); // available = 5

      // Run two simultaneous additions of 3 (combined = 6 > 5)
      const results = await Promise.allSettled([
        cartService.addItem(fixture.customerId, {
          productId: fixture.productId,
          quantity: 3,
        }),
        cartService.addItem(fixture.customerId, {
          productId: fixture.productId,
          quantity: 3,
        }),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');

      // Exactly one must succeed and one must be rejected
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);

      const rejectedError = (rejected[0] as PromiseRejectedResult).reason;
      expect(rejectedError).toBeInstanceOf(BadRequestException);
      expect(rejectedError.message).toMatch(/exceeds available stock/);

      // Final cart quantity must be exactly 3
      const cart = await cartService.getCart(fixture.customerId);
      expect(cart.cart.items).toHaveLength(1);
      expect(cart.cart.items[0].quantity).toBe(3);
    });
  });

  describe('E. Customer isolation', () => {
    it('prevents one customer from accessing or modifying another customers cart items', async () => {
      const fixture = await createFixture(10, 0);

      // Customer 1 adds item to their cart
      const addRes = await cartService.addItem(fixture.customerId, {
        productId: fixture.productId,
        quantity: 2,
      });
      const customer1ItemId = addRes.item.id;

      // Customer 2 attempts to update Customer 1's cart item -> 404
      await expect(
        cartService.updateItem(fixture.customer2Id, customer1ItemId, {
          quantity: 5,
        }),
      ).rejects.toBeInstanceOf(NotFoundException);

      // Customer 2 attempts to remove Customer 1's cart item -> 404
      await expect(
        cartService.removeItem(fixture.customer2Id, customer1ItemId),
      ).rejects.toBeInstanceOf(NotFoundException);

      // Customer 1's item remains unchanged with quantity 2
      const cart1 = await cartService.getCart(fixture.customerId);
      expect(cart1.cart.items).toHaveLength(1);
      expect(cart1.cart.items[0].id).toBe(customer1ItemId);
      expect(cart1.cart.items[0].quantity).toBe(2);

      // Customer 2's cart remains completely empty
      const cart2 = await cartService.getCart(fixture.customer2Id);
      expect(cart2.cart.items).toHaveLength(0);
    });
  });
});
