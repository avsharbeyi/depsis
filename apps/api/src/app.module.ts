import { Module } from '@nestjs/common';

import { DbModule } from './db/db.module.js';
import { HealthModule } from './health/health.module.js';
import { OrganizationsModule } from './organizations/organizations.module.js';

@Module({
  imports: [DbModule, HealthModule, OrganizationsModule],
})
export class AppModule {}
