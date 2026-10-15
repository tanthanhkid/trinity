import { Controller, Get, INestApplication } from '@nestjs/common'
import { DiscoveryModule } from '@nestjs/core'
import { Test } from '@nestjs/testing'
import { auditRoutes } from './route-audit'
import { Can, Public } from './decorators'

@Controller('no-meta')
class NoMetaController {
  @Get('list')
  list() {
    return []
  }
}

@Controller('half-export')
class HalfExportController {
  @Get('export')
  @Can('contacts.view')
  export() {
    return []
  }
}

@Controller('clean-export')
class CleanExportController {
  @Get('export')
  @Can('contacts.export')
  export() {
    return []
  }
}

@Controller('static')
class StaticController {
  @Get('template-export')
  @Public()
  template() {
    return []
  }
}

describe('auditRoutes', () => {
  let app: INestApplication

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [DiscoveryModule],
      controllers: [NoMetaController, HalfExportController, CleanExportController, StaticController],
    }).compile()
    app = moduleRef.createNestApplication()
    await app.init()
  })

  afterAll(async () => {
    await app.close()
  })

  it('route không khai báo metadata → nằm trong missing', () => {
    const { missing } = auditRoutes(app)
    expect(missing).toContain('/no-meta/list')
  })

  it("route export gắn quyền KHÔNG kết thúc .export → nằm trong exportWithoutPerm", () => {
    const { exportWithoutPerm } = auditRoutes(app)
    expect(exportWithoutPerm).toContain('/half-export/export')
  })

  it('route export gắn đúng quyền *.export → sạch', () => {
    const { exportWithoutPerm } = auditRoutes(app)
    expect(exportWithoutPerm).not.toContain('/clean-export/export')
  })

  it('route export gắn @Public (ngoại lệ file tĩnh) → sạch', () => {
    const { exportWithoutPerm, missing } = auditRoutes(app)
    expect(exportWithoutPerm).not.toContain('/static/template-export')
    expect(missing).not.toContain('/static/template-export')
  })
})
