import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { loadEnvironment } from "./config/environment";
import { HealthController } from "./health/health.controller";
import { RateLimitModule } from "./modules/rate-limit";
import { EmailModule } from "./modules/email";
import { AuthModule } from "./modules/auth";
import { ExpertsModule } from "./modules/experts";
import { KnowledgeModule } from "./modules/knowledge";
import { ConnectionsModule } from "./modules/connections";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ["../../.env", ".env"],
      validate: loadEnvironment,
    }),
    RateLimitModule,
    EmailModule,
    AuthModule,
    ExpertsModule,
    KnowledgeModule,
    ConnectionsModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
