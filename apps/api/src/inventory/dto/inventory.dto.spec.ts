import 'reflect-metadata';

import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { AdjustInventoryDto } from './adjust-inventory.dto.js';
import { InventoryMovementsQueryDto } from './inventory-movements-query.dto.js';

describe('Inventory DTO validation', () => {
  async function validationErrors(instance: object) {
    return validate(instance);
  }

  it('rejects a zero quantity adjustment', async () => {
    const errors = await validationErrors(
      plainToInstance(AdjustInventoryDto, {
        quantityChange: 0,
        reason: 'Stock count',
      }),
    );

    expect(errors).not.toHaveLength(0);
  });

  it('rejects a non-integer quantity adjustment', async () => {
    const errors = await validationErrors(
      plainToInstance(AdjustInventoryDto, {
        quantityChange: 1.5,
        reason: 'Stock count',
      }),
    );

    expect(errors).not.toHaveLength(0);
  });

  it('rejects a missing reason', async () => {
    const errors = await validationErrors(
      plainToInstance(AdjustInventoryDto, { quantityChange: 1 }),
    );

    expect(errors).not.toHaveLength(0);
  });

  it('rejects a whitespace-only reason after trimming it', async () => {
    const errors = await validationErrors(
      plainToInstance(AdjustInventoryDto, {
        quantityChange: 1,
        reason: '   ',
      }),
    );

    expect(errors).not.toHaveLength(0);
  });

  it('rejects an excessively long reason', async () => {
    const errors = await validationErrors(
      plainToInstance(AdjustInventoryDto, {
        quantityChange: 1,
        reason: 'a'.repeat(501),
      }),
    );

    expect(errors).not.toHaveLength(0);
  });

  it('rejects invalid page and limit values', async () => {
    const errors = await validationErrors(
      plainToInstance(InventoryMovementsQueryDto, { page: 0, limit: 0 }),
    );

    expect(errors).not.toHaveLength(0);
  });

  it('enforces the maximum page and limit', async () => {
    const errors = await validationErrors(
      plainToInstance(InventoryMovementsQueryDto, {
        page: 10_001,
        limit: 101,
      }),
    );

    expect(errors).not.toHaveLength(0);
  });

  it('accepts the maximum limit with valid defaults', async () => {
    const query = plainToInstance(InventoryMovementsQueryDto, { limit: 100 });
    const errors = await validationErrors(query);

    expect(errors).toHaveLength(0);
    expect(query.page).toBe(1);
    expect(query.limit).toBe(100);
  });
});
