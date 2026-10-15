import { Injectable, Logger } from '@nestjs/common'
import * as ExcelJS from 'exceljs'
import { UsersService } from './users.service'

// Một dòng người dùng đã map (đồng bộ với output findAllForExport).
type UserRow = Awaited<
  ReturnType<UsersService['findAllForExport']>
>[number]

type ExportParams = Parameters<UsersService['findAllForExport']>[0]
type ExportUser = Parameters<UsersService['findAllForExport']>[1]

interface ColumnDef {
  header: string
  key: string
  numeric?: boolean
}

// Cột xuất: STT, Họ và tên, Vai trò, Tình trạng tài khoản.
const COLUMNS: ColumnDef[] = [
  { header: 'STT', key: 'stt', numeric: true },
  { header: 'Họ và tên', key: 'full_name' },
  { header: 'Vai trò', key: 'roles' },
  { header: 'Tình trạng tài khoản', key: 'status' },
]

const COL_MIN_WIDTH = 10
const COL_MAX_WIDTH = 50
const HEADER_ROW = 2 // row 1 = tiêu đề + tổng số, row 2 = header cột

// Vai trò là tên hiển thị do admin tự đặt (Cài đặt > Vai trò), không có slug cố
// định cần bảng dịch riêng. `roles[]` (findAll/findById) đã LÀ nhãn hiển thị,
// export chỉ cần join.

// Tình trạng tài khoản — khớp nhãn UI (edit-user-dialog.tsx).
const STATUS_LABELS: Record<string, string> = {
  active: 'Hoạt động',
  locked: 'Đã khoá',
}

@Injectable()
export class UserListExportService {
  private readonly logger = new Logger(UserListExportService.name)

  constructor(private readonly usersService: UsersService) {}

  /**
   * Xuất Excel danh sách người dùng theo bộ lọc + RBAC scope hiện hành.
   * Tái dùng findAllForExport → file khớp 100% với danh sách đang hiển thị.
   */
  async exportToExcel(
    params: ExportParams,
    currentUser: ExportUser,
  ): Promise<Buffer> {
    const rows = await this.usersService.findAllForExport(params, currentUser)
    this.logger.log(`Exporting ${rows.length} user rows`)
    return this.generateExcel(rows)
  }

  private toCellValues(
    r: UserRow,
    index: number,
  ): Record<string, string | number> {
    return {
      stt: index + 1,
      full_name: r.full_name ?? '',
      roles: r.roles.length > 0 ? r.roles.join(', ') : '',
      status: r.status ? (STATUS_LABELS[r.status] ?? r.status) : '',
    }
  }

  private async generateExcel(rows: UserRow[]): Promise<Buffer> {
    const workbook = new ExcelJS.Workbook()
    workbook.creator = 'Trinity CRM'
    workbook.created = new Date()

    const sheet = workbook.addWorksheet('Người dùng')
    const lastCol = COLUMNS.length
    sheet.columns = COLUMNS.map((c) => ({ key: c.key }))

    // Hàng 1: tiêu đề + tổng số (bold, merge)
    sheet.mergeCells(1, 1, 1, lastCol)
    const titleCell = sheet.getCell(1, 1)
    titleCell.value = `DANH SÁCH TÀI KHOẢN NGƯỜI DÙNG · Tổng ${rows.length} tài khoản`
    titleCell.font = { bold: true, size: 14 }
    titleCell.alignment = { horizontal: 'center', vertical: 'middle' }

    // Hàng 2: header cột — bold, nền xanh thương hiệu, chữ trắng
    const headerRow = sheet.getRow(HEADER_ROW)
    COLUMNS.forEach((c, i) => {
      const cell = headerRow.getCell(i + 1)
      cell.value = c.header
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } }
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FF1D9452' },
      }
      cell.alignment = {
        horizontal: 'center',
        vertical: 'middle',
        wrapText: false,
      }
    })

    // Dữ liệu (bắt đầu hàng 3)
    const cellValues = rows.map((r, i) => this.toCellValues(r, i))
    for (const values of cellValues) {
      const row = sheet.addRow(values)
      COLUMNS.forEach((c, i) => {
        row.getCell(i + 1).alignment = {
          vertical: 'middle',
          horizontal: c.numeric ? 'right' : 'left',
          wrapText: false,
        }
      })
    }

    // Auto-fit độ rộng cột theo nội dung dài nhất.
    COLUMNS.forEach((c, i) => {
      let maxLen = c.header.length
      for (const values of cellValues) {
        const v = values[c.key]
        const len = v === undefined || v === null ? 0 : String(v).length
        if (len > maxLen) maxLen = len
      }
      sheet.getColumn(i + 1).width = Math.min(
        COL_MAX_WIDTH,
        Math.max(COL_MIN_WIDTH, maxLen + 2),
      )
    })

    sheet.views = [{ state: 'frozen', ySplit: HEADER_ROW }]

    const buffer = await workbook.xlsx.writeBuffer()
    return Buffer.from(buffer)
  }
}
