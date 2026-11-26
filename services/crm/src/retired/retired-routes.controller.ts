import { Controller, Get, HttpCode, HttpException, HttpStatus, Post } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Public } from '@trinity/rbac-nest';

/** Câu trả lời 410 chung cho đường công khai của kết nối đã gỡ. */
export function goneError(what: string): HttpException {
  return new HttpException(
    { statusCode: HttpStatus.GONE, error: 'Gone', message: `${what} đã ngừng hỗ trợ trên Trinity. / This integration has been removed.` },
    HttpStatus.GONE,
  );
}

/**
 * Đường CÔNG KHAI của tính năng đã gỡ (docs/rust/PLAN.md mục 2.3): trả 410 để bên ngoài (nhà cung cấp, trình duyệt
 * quay về từ trang đăng nhập) biết đường này không còn, thay vì 404 làm họ thử lại. Đường cần đăng nhập thì để 404.
 */
@ApiExcludeController()
@Controller()
export class RetiredRoutesController {
  /** G03: OAuth Google cho đồng bộ Google Sheets. */
  @Get('integrations/google/oauth/callback')
  @Public()
  googleOAuthCallback(): never {
    throw goneError('Kết nối Google Sheets');
  }

  /**
   * G06: kết nối phần mềm bán hàng và sàn TMĐT đã gỡ. Webhook (`/connectors/<nhà cung cấp>/webhook/<token>`), push của
   * sàn (`/connectors/<sàn>/push`) và callback cấp quyền (`/connectors/<sàn>/callback`) trả 410 để phía gửi ngừng thử lại.
   * Khai báo theo tham số (không liệt kê tên): không route còn sống nào có dạng này (`/connectors/sepay/webhook` không có
   * token, IPN là `/ipn`).
   */
  @Post('connectors/:provider/webhook/:token')
  @Public()
  @HttpCode(410)
  salesWebhook(): never {
    throw goneError('Kết nối phần mềm bán hàng');
  }

  @Post('connectors/:provider/push')
  @Public()
  @HttpCode(410)
  marketplacePush(): never {
    throw goneError('Kết nối sàn thương mại điện tử');
  }

  @Get('connectors/:provider/callback')
  @Public()
  marketplaceCallback(): never {
    throw goneError('Kết nối sàn thương mại điện tử');
  }
}
