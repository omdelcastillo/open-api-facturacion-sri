import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  HttpCode,
  Body,
  Param,
  Query,
  Logger,
  ParseUUIDPipe,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole } from '../auth/dto/auth.dto';
import { CatalogosAdminService } from './catalogos-admin.service';
import { CreateCatalogoRetencionDto, UpdateCatalogoRetencionDto, CatalogoRetencionResponseDto } from './dto/catalogo-retencion.dto';

@ApiTags('Catálogos Admin')
@ApiBearerAuth()
@Controller('catalogos/admin')
@Roles(UserRole.SUPERADMIN, UserRole.ADMIN)
export class CatalogosAdminController {
  private readonly logger = new Logger(CatalogosAdminController.name);

  constructor(private readonly adminService: CatalogosAdminService) {}

  @Get('retenciones')
  @ApiOperation({ summary: 'Listar todas las retenciones (incluye inactivas)' })
  @ApiQuery({ name: 'includeInactive', required: false, type: Boolean, description: 'Incluir retenciones inactivas' })
  @ApiResponse({ status: 200, type: [CatalogoRetencionResponseDto] })
  async listRetenciones(@Query('includeInactive') includeInactive?: string): Promise<CatalogoRetencionResponseDto[]> {
    const include = includeInactive === 'true' || includeInactive === '1';
    return this.adminService.findAllRetenciones(include);
  }

  @Get('retenciones/:id')
  @ApiOperation({ summary: 'Obtener una retención por ID' })
  @ApiResponse({ status: 200, type: CatalogoRetencionResponseDto })
  async getRetencion(@Param('id', ParseUUIDPipe) id: string): Promise<CatalogoRetencionResponseDto> {
    return this.adminService.findRetencionById(id);
  }

  @Post('retenciones')
  @ApiOperation({ summary: 'Crear una nueva retención' })
  @ApiResponse({ status: 201, type: CatalogoRetencionResponseDto })
  async createRetencion(@Body() dto: CreateCatalogoRetencionDto): Promise<CatalogoRetencionResponseDto> {
    this.logger.log(`POST /catalogos/admin/retenciones - ${dto.tipo}-${dto.codigo}`);
    return this.adminService.createRetencion(dto);
  }

  @Patch('retenciones/:id')
  @ApiOperation({ summary: 'Actualizar una retención' })
  @ApiResponse({ status: 200, type: CatalogoRetencionResponseDto })
  async updateRetencion(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCatalogoRetencionDto,
  ): Promise<CatalogoRetencionResponseDto> {
    this.logger.log(`PATCH /catalogos/admin/retenciones/${id}`);
    return this.adminService.updateRetencion(id, dto);
  }

  @Delete('retenciones/:id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Desactivar una retención (soft delete)' })
  @ApiResponse({ status: 204 })
  async deleteRetencion(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    this.logger.log(`DELETE /catalogos/admin/retenciones/${id}`);
    await this.adminService.deleteRetencion(id);
  }
}
