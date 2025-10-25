import { Controller, Post, Body } from '@nestjs/common';
import { BotserviceService } from './botservice.service';

@Controller('botservice')
export class BotserviceController {
  constructor(private readonly botserviceService: BotserviceService) { }
  @Post('send')
  async send(@Body() body) {
    return this.botserviceService.sendOrderToChats(body);
  }
}
