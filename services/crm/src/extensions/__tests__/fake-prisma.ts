/**
 * Prisma giả TRONG BỘ NHỚ — chỉ đủ các hàm mà ExtensionsService / ExtensionRunLog / ExtensionsRuntime gọi, để test luồng nháp–duyệt–deploy
 * chạy mặc định (không cần Postgres). Có TEST_DATABASE_URL thì `extensions.service.spec.ts` chạy lại cùng kịch bản trên DB thật.
 */
type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

class Table {
  rows: Row[] = [];
  private seq = 0;
  constructor(private readonly defaults: () => Row, private readonly unique: string[][] = []) {}

  private match(r: Row, where: Row = {}): boolean {
    return Object.entries(where).every(([k, cond]) => {
      if (k === 'extension_id_version') return r.extension_id === cond.extension_id && r.version === cond.version;
      const v = r[k];
      if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
        if ('not' in cond) return v !== cond.not;
        if ('gt' in cond) return v > cond.gt;
        if ('lt' in cond) return v < cond.lt;
        if ('lte' in cond) return v <= cond.lte;
        if ('in' in cond) return cond.in.includes(v);
      }
      return v === cond;
    });
  }

  create = async ({ data }: { data: Row; select?: Row }) => {
    const row: Row = { ...this.defaults(), ...data, id: ++this.seq };
    for (const cols of this.unique) {
      if (this.rows.some((o) => !o.deleted_at && cols.every((c) => o[c] === row[c]))) throw Object.assign(new Error('unique'), { code: 'P2002' });
    }
    this.rows.push(row);
    return { ...row };
  };
  findFirst = async ({ where, orderBy }: { where?: Row; orderBy?: Row }) => this.sorted(this.rows.filter((r) => this.match(r, where)), orderBy)[0] ?? null;
  findFirstOrThrow = async (a: { where?: Row; orderBy?: Row }) => (await this.findFirst(a)) ?? Promise.reject(new Error('not found'));
  findUnique = async ({ where }: { where: Row }) => this.rows.find((r) => this.match(r, where)) ?? null;
  findUniqueOrThrow = async (a: { where: Row }) => (await this.findUnique(a)) ?? Promise.reject(new Error('not found'));
  findMany = async ({ where, orderBy, take, skip }: { where?: Row; orderBy?: Row; take?: number; skip?: number } = {}) =>
    this.sorted(this.rows.filter((r) => this.match(r, where)), orderBy).slice(skip ?? 0, (skip ?? 0) + (take ?? 1e9));
  count = async ({ where }: { where?: Row } = {}) => this.rows.filter((r) => this.match(r, where)).length;
  update = async ({ where, data }: { where: Row; data: Row }) => {
    const r = this.rows.find((x) => this.match(x, where));
    if (!r) throw new Error('not found');
    this.apply(r, data);
    return { ...r };
  };
  updateMany = async ({ where, data }: { where?: Row; data: Row }) => {
    const hit = this.rows.filter((r) => this.match(r, where));
    hit.forEach((r) => this.apply(r, data));
    return { count: hit.length };
  };
  deleteMany = async ({ where }: { where?: Row }) => {
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => !this.match(r, where));
    return { count: before - this.rows.length };
  };
  private apply(r: Row, data: Row): void {
    for (const [k, v] of Object.entries(data)) r[k] = v && typeof v === 'object' && 'increment' in v ? (r[k] ?? 0) + v.increment : v;
    r.updated_at = new Date();
  }
  private sorted(rows: Row[], orderBy?: Row): Row[] {
    if (!orderBy) return rows.map((r) => ({ ...r }));
    const [k, dir] = Object.entries(orderBy)[0] as [string, 'asc' | 'desc'];
    return rows.map((r) => ({ ...r })).sort((a, b) => (dir === 'desc' ? b[k] - a[k] : a[k] - b[k]));
  }
}

export function fakePrisma() {
  const now = () => new Date();
  const p = {
    extension: new Table(() => ({ description: '', status: 'draft', active_version_id: null, latest_version: 0, disabled_reason: null, consecutive_failures: 0, created_at: now(), updated_at: now(), deleted_at: null }), [['key']]),
    extensionVersion: new Table(() => ({ note: null, review_status: 'draft', review_note: null, reviewed_by: null, reviewed_at: null, created_at: now() }), [['extension_id', 'version']]),
    extensionRun: new Table(() => ({ started_at: now(), duration_ms: 0, peak_rss_kb: null, result: null })),
    $transaction: async (fn: (tx: unknown) => unknown) => fn(p),
    $queryRaw: async () => [],
  };
  return p;
}
export type FakePrisma = ReturnType<typeof fakePrisma>;
