import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BotserviceModule } from './botservice/botservice.module';

@Module({
  imports: [
    BotserviceModule,
    ConfigModule.forRoot({
      isGlobal:true,
    })
  ],
  controllers: [],
  providers: [],
})
export class AppModule {}
