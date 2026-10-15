import { Injectable } from '@nestjs/common';
import * as ExcelJS from 'exceljs';
import type { AuthUser } from '@trinity/rbac-nest';
import { ReportPeriod } from './helpers/report-date-range.helper';
import {
  ReportEmployeePerformanceService,
  EmployeePerformanceRow,
} from './report-employee-performance.service';

/** Không phải PII khách hàng (chỉ tên NV + số liệu tổng hợp). */
const EXPORT_CAP = 5_000;

@Injectable()
export class ReportEmployeePerformanceExportService {
  constructor(private readonly performanceService: ReportEmployeePerformanceService) {}

  async exportToExcel(user: AuthUser, period: ReportPeriod): Promise<Buffer> {
    const rows = await this.performanceService.getPerformance(user, period);
    const sorted = [...rows].sort((a, b) => b.new_customers - a.new_customers);
    const truncated = sorted.length > EXPORT_CAP;
    return this.generateExcel(sorted.slice(0, EXPORT_CAP), truncated);
  }

  private async generateExcel(rows: EmployeePerformanceRow[], truncated: boolean): Promise<Buffer> {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Trinity CRM';
    workbook.created = new Date();
    const sheet = workbook.addWorksheet('Hiệu suất nhân viên');

    sheet.columns = [
      { header: 'STT', key: 'stt', width: 6 },
      { header: 'Nhân viên', key: 'full_name', width: 26 },
      { header: 'Email', key: 'email', width: 26 },
      { header: 'Khách mới được giao', key: 'new_customers', width: 18 },
      { header: 'Số hoạt động', key: 'activities_count', width: 16 },
    ];
    const headerRow = sheet.getRow(1);
    headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1D9452' } };

    rows.forEach((r, idx) => {
      sheet.addRow({
        stt: idx + 1,
        full_name: r.full_name,
        email: r.email,
        new_customers: r.new_customers,
        activities_count: r.activities_count,
      });
    });

    let headerSplit = 1;
    if (truncated) {
      sheet.spliceRows(2, 0, [
        `⚠ Danh sách vượt ${EXPORT_CAP.toLocaleString('vi-VN')} nhân viên — chỉ hiện ${EXPORT_CAP.toLocaleString('vi-VN')} dòng đầu (sắp theo khách mới giảm dần).`,
      ]);
      sheet.mergeCells(2, 1, 2, 8);
      sheet.getRow(2).font = { bold: true, color: { argb: 'FFB45309' } };
      headerSplit = 2;
    }
    sheet.views = [{ state: 'frozen', ySplit: headerSplit }];

    const buffer = await workbook.xlsx.writeBuffer();
    return Buffer.from(buffer);
  }
}
