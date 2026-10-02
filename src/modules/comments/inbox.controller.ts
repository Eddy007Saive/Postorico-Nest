import { BadRequestException, Body, Controller, Get, HttpException, HttpStatus, Logger, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtPayload } from '../auth/auth.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { LateService } from '../late/late.service';
import { InboxActionDto } from './dto/inbox-action.dto';
import { InboxReplyDto } from './dto/inbox-reply.dto';
import { InboxService } from './inbox.service';

type AuthedRequest = Request & { user: JwtPayload };

/** Port direct de backend/routes/inbox.py. */
@Controller('inbox')
export class InboxController {
  private readonly logger = new Logger(InboxController.name);

  constructor(
    private readonly inboxService: InboxService,
    private readonly lateService: LateService,
  ) {}

  /** Webhook Late `comment.received` (public, vérifié par signature) -> push temps réel. */
  @Post('webhook')
  async webhook(@Req() req: AuthedRequest & { rawBody?: Buffer }) {
    const raw = req.rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));
    // Zernio signe avec X-Zernio-Signature (ancien nom : X-Late-Signature)
    const sig = (req.headers['x-zernio-signature'] as string) || (req.headers['x-late-signature'] as string) || '';
    if (!this.lateService.verifySignature(raw, sig)) {
      throw new HttpException('Signature invalide', HttpStatus.UNAUTHORIZED);
    }
    let payload: Record<string, unknown> = {};
    try {
      payload = raw.length ? JSON.parse(raw.toString('utf-8')) : {};
    } catch {
      payload = {};
    }
    let res: Record<string, unknown>;
    try {
      res = await this.inboxService.handleCommentWebhook(payload);
    } catch (e) {
      this.logger.error(`Inbox webhook error: ${e instanceof Error ? e.message : e}`);
      res = { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    return { received: true, ...res };
  }

  @Get()
  @UseGuards(JwtAuthGuard)
  async listInbox(@Query('platform') platform: string | undefined, @Req() req: AuthedRequest) {
    return this.inboxService.listInbox(req.user.telegram_id, platform);
  }

  @Get('post/:postId')
  @UseGuards(JwtAuthGuard)
  async postComments(@Param('postId') postId: string, @Query('account_id') accountId: string) {
    return this.inboxService.postComments(postId, accountId);
  }

  @Post('reply')
  @UseGuards(JwtAuthGuard)
  async reply(@Body() body: InboxReplyDto) {
    const message = (body.message || '').trim();
    if (!(body.post_id && body.account_id && message)) throw new BadRequestException('post_id, account_id et message requis');
    const r = await this.inboxService.reply(body.post_id, body.account_id, message, body.comment_id);
    if (!r.ok) throw new BadRequestException(r.error);
    return r;
  }

  @Post('action')
  @UseGuards(JwtAuthGuard)
  async action(@Body() body: InboxActionDto) {
    const r = await this.inboxService.action(body.kind, body.post_id, body.comment_id, body.account_id);
    if (!r.ok) throw new BadRequestException(r.error);
    return r;
  }
}
