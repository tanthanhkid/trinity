import { Module } from '@nestjs/common';
import { ProductsController } from './products.controller';
import { ProductsService } from './products.service';
import { ProductCategoriesController } from './categories/product-categories.controller';
import { ProductCategoriesService } from './categories/product-categories.service';
import { ProductAttributeDefsController } from './attribute-defs/product-attribute-defs.controller';
import { ProductAttributeDefsService } from './attribute-defs/product-attribute-defs.service';

/**
 * khung khai báo chung đa ngành: thêm `ProductCategoriesController`
 * (danh mục/ngành) + `ProductAttributeDefsController` (định nghĩa thuộc tính
 * động của từng danh mục), cả 2 RBAC ghi CÙNG quyền sửa sản phẩm
 * (`super_admin`/`operations`). `ProductsService` phụ thuộc
 * `ProductAttributeDefsService` (validate `attributes` theo defs của category)
 * — khai TRONG CÙNG module để tránh vòng phụ thuộc module.
 */
@Module({
  controllers: [ProductsController, ProductCategoriesController, ProductAttributeDefsController],
  providers: [ProductsService, ProductCategoriesService, ProductAttributeDefsService],
})
export class ProductsModule {}
