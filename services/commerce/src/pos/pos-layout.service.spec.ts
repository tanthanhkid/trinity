import { PosLayoutService } from './pos-layout.service';

describe('PosLayoutService.updateModifier', () => {
  const build = () => {
    const update = jest.fn().mockResolvedValue({ id: 1, price_delta: 0n });
    const svc = new PosLayoutService({ posModifier: { update } } as never);
    return { svc, update };
  };

  it('price_delta: null không làm BigInt(null) ném TypeError (500) — bỏ qua trường', async () => {
    const { svc, update } = build();
    await expect(svc.updateModifier(1, { price_delta: null } as never)).resolves.toBeDefined();
    expect(update.mock.calls[0][0].data.price_delta).toBeUndefined();
  });

  it('price_delta số được đổi sang BigInt', async () => {
    const { svc, update } = build();
    await svc.updateModifier(1, { price_delta: 5000 } as never);
    expect(update.mock.calls[0][0].data.price_delta).toBe(5000n);
  });
});
