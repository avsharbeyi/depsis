import { Module } from '@nestjs/common';

import { OrganizationsService } from './organizations.service.js';

@Module({
  providers: [OrganizationsService],
  exports: [OrganizationsService],
})
export class OrganizationsModule {}
