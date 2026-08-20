import { Module } from '@nestjs/common';

import { AuthModule } from './auth/auth.module.js';
import { DbModule } from './db/db.module.js';
import { HealthModule } from './health/health.module.js';
import { OrganizationsModule } from './organizations/organizations.module.js';

@Module({
  imports: [DbModule, AuthModule, HealthModule, OrganizationsModule],
})
export class AppModule {}
