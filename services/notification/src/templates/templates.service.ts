import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common'
import { PrismaService } from '@trinity/prisma'
import * as Handlebars from 'handlebars'

/**
 * Template do quản trị công ty sửa ⇒ coi là dữ liệu không tin cậy. Chỉ cho helper có sẵn (`if`, `each`, `with`, `unless`,
 * `lookup`, `log`), cấm gọi helper lạ; truy cập prototype mặc định đã chặn (`allowProto*` = false). Cùng handlebars ≥ 4.7.10
 * (vá chèn JS qua AST / own-property bypass).
 */
const SAFE_COMPILE: CompileOptions = { knownHelpersOnly: true, strict: false }
import { CreateTemplateDto } from './dto/create-template.dto'
import { UpdateTemplateDto } from './dto/update-template.dto'

interface RenderedTemplate {
  subject: string | null
  body: string
}

@Injectable()
export class TemplatesService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(): Promise<unknown[]> {
    return this.prisma.notificationTemplate.findMany({
      orderBy: { created_at: 'desc' },
    })
  }

  async findById(id: number) {
    const template = await this.prisma.notificationTemplate.findUnique({
      where: { id },
    })
    if (!template) {
      throw new NotFoundException(`Template #${id} khong ton tai`)
    }
    return template
  }

  /** Handlebars.compile là lazy — cú pháp sai chỉ nổ lúc render; parse ngay khi lưu để trả 400 thay vì làm hỏng handler sự kiện. */
  private assertValidSyntax(...sources: Array<string | null | undefined>): void {
    for (const src of sources) {
      if (!src) continue
      try {
        Handlebars.precompile(src, SAFE_COMPILE)
      } catch (err) {
        throw new BadRequestException(`Cú pháp template không hợp lệ: ${(err as Error).message.split('\n')[0]}`)
      }
    }
  }

  async create(dto: CreateTemplateDto): Promise<unknown> {
    this.assertValidSyntax(dto.subject, dto.body)
    return this.prisma.notificationTemplate.create({
      data: {
        name: dto.name,
        event_type: dto.event_type,
        channel: dto.channel,
        subject: dto.subject ?? null,
        body: dto.body,
        recipients_rule: (dto.recipients_rule ?? undefined) as never,
        is_active: dto.is_active ?? true,
      },
    })
  }

  async update(id: number, dto: UpdateTemplateDto): Promise<unknown> {
    await this.findById(id)
    this.assertValidSyntax(dto.subject, dto.body)
    return this.prisma.notificationTemplate.update({
      where: { id },
      data: {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.event_type !== undefined && { event_type: dto.event_type }),
        ...(dto.channel !== undefined && { channel: dto.channel }),
        ...(dto.subject !== undefined && { subject: dto.subject }),
        ...(dto.body !== undefined && { body: dto.body }),
        ...(dto.recipients_rule !== undefined && {
          recipients_rule: dto.recipients_rule as never,
        }),
        ...(dto.is_active !== undefined && { is_active: dto.is_active }),
      },
    })
  }

  async remove(id: number): Promise<unknown> {
    await this.findById(id)
    return this.prisma.notificationTemplate.delete({ where: { id } })
  }

  async render(
    templateId: number,
    data: Record<string, unknown>,
  ): Promise<RenderedTemplate> {
    const template = await this.findById(templateId)

    const compiledBody = Handlebars.compile(template.body, SAFE_COMPILE)
    const renderedBody = compiledBody(data)

    let renderedSubject: string | null = null
    if (template.subject) {
      const compiledSubject = Handlebars.compile(template.subject, SAFE_COMPILE)
      renderedSubject = compiledSubject(data)
    }

    return { subject: renderedSubject, body: renderedBody }
  }

  async renderByEventType(
    eventType: string,
    channel: string,
    data: Record<string, unknown>,
  ): Promise<RenderedTemplate | null> {
    const template = await this.prisma.notificationTemplate.findFirst({
      where: {
        event_type: eventType,
        channel,
        is_active: true,
      },
    })

    if (!template) return null

    const compiledBody = Handlebars.compile(template.body, SAFE_COMPILE)
    const renderedBody = compiledBody(data)

    let renderedSubject: string | null = null
    if (template.subject) {
      const compiledSubject = Handlebars.compile(template.subject, SAFE_COMPILE)
      renderedSubject = compiledSubject(data)
    }

    return { subject: renderedSubject, body: renderedBody }
  }
}
