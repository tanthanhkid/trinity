import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthUser, Can, CurrentUser } from '@trinity/rbac-nest';
import { ParseInt4Pipe } from '../common/validation/int4';
import { CreateOrderDto, ListOrdersQueryDto, PayOrderDto, QrQueryDto, UpdateOrderDto, VoidOrderDto } from './dto/order.dto';
import { PosOrdersService } from './pos-orders.service';
import { PosQrService } from './pos-qr.service';

/** POS — đơn hàng. Tổng tiền do BE tính; client KHÔNG gửi giá. */
@ApiTags('POS')
@ApiBearerAuth()
@Can('pos.sell')
@Controller('pos/orders')
export class PosOrdersController {
  constructor(private readonly orders: PosOrdersService, private readonly qr: PosQrService) {}

  @Post()
  @ApiOperation({ summary: 'Tạo đơn (cần ca đang mở)' })
  create(@Body() dto: CreateOrderDto, @CurrentUser() user: AuthUser) { return this.orders.create(dto, user); }

  @Get()
  list(@Query() q: ListOrdersQueryDto, @CurrentUser() user: AuthUser) { return this.orders.list(q, user); }

  @Get(':id')
  get(@Param('id', ParseInt4Pipe) id: number, @CurrentUser() user: AuthUser) { return this.orders.getById(id, user); }

  @Patch(':id')
  @ApiOperation({ summary: 'Sửa đơn đang mở (gửi items = thay toàn bộ dòng món)' })
  update(@Param('id', ParseInt4Pipe) id: number, @Body() dto: UpdateOrderDto, @CurrentUser() user: AuthUser) {
    return this.orders.update(id, dto, user);
  }

  @Post(':id/pay')
  @ApiOperation({ summary: 'Thanh toán (tiền mặt / chuyển khoản, có thể chia nhiều dòng)' })
  pay(@Param('id', ParseInt4Pipe) id: number, @Body() dto: PayOrderDto, @CurrentUser() user: AuthUser) {
    return this.orders.pay(id, dto, user);
  }

  @Post(':id/void')
  @ApiOperation({ summary: 'Huỷ đơn có lý do (đơn đã thu: chỉ quản lý)' })
  void(@Param('id', ParseInt4Pipe) id: number, @Body() dto: VoidOrderDto, @CurrentUser() user: AuthUser) {
    return this.orders.voidOrder(id, dto, user);
  }

  @Get(':id/qr')
  @ApiOperation({ summary: 'Chuỗi VietQR chuyển khoản cho đơn đang mở' })
  qrCode(@Param('id', ParseInt4Pipe) id: number, @Query() q: QrQueryDto, @CurrentUser() user: AuthUser) {
    return this.qr.forOrder(id, user, q.amount);
  }
}
