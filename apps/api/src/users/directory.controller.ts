import { Controller, Get, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import type { OpenApi } from '@depsis/contracts';

import { SessionGuard, type AuthenticatedRequest } from '../auth/session.guard.js';
import { UsersService } from './users.service.js';

type Schemas = OpenApi.components['schemas'];

/**
 * Kuruluşun hesap adları, her oturuma açık.
 *
 * AYRI BİR DENETLEYİCİ OLMASININ NEDENİ NEST'İN KENDİSİ. `UsersController`'ın sınıf seviyesindeki
 * `AdminGuard`'ı her rotasında çalışır ve tek bir rotada KAPATILAMAZ; oraya eklenen bir "herkese
 * açık" uç ya sessizce yönetici-özel kalırdı ya da sınıfın koruyucusunu gevşetmeyi gerektirirdi.
 * İkincisi, hesap yönetiminin tamamını açardı.
 *
 * NEDEN VAR. §6.2'nin `manage` izni bir klasörün yönetimini sıradan bir üyeye devredebiliyor ve
 * `PermissionsController` bunu bilerek `AdminGuard` olmadan sunuyor. O üye izin verebiliyordu ama
 * kime vereceğini seçemiyordu: `/users` ona 403 dönüyor, arayüz de o 403'ü `?? []` ile boş listeye
 * çeviriyordu. Sonuç, hata mesajı olmayan bir çıkmazdı — devredilmiş yetkiyi kâğıt üstünde bırakan
 * türden.
 */
@Controller('directory')
@UseGuards(SessionGuard)
export class DirectoryController {
  constructor(private readonly users: UsersService) {}

  @Get('users')
  async list(@Req() request: AuthenticatedRequest): Promise<Schemas['DirectoryPage']> {
    const session = request.depsis;
    if (session === undefined) throw new UnauthorizedException('oturum yok');
    return { items: await this.users.directory(session.organizationId) };
  }
}
