import { Module } from '@nestjs/common';

import { AgentModule } from './agent/agent.module.js';
import { AuthModule } from './auth/auth.module.js';
import { DbModule } from './db/db.module.js';
import { HealthModule } from './health/health.module.js';
import { MeModule } from './me/me.module.js';
import { OrganizationsModule } from './organizations/organizations.module.js';
import { SetupModule } from './setup/setup.module.js';

@Module({
  imports: [
    DbModule,
    AgentModule,
    AuthModule,
    HealthModule,
    MeModule,
    OrganizationsModule,
    SetupModule,
  ],
})
export class AppModule {}
